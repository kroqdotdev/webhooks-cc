# Supabase Migration Design

Migrate webhooks.cc from Convex (cloud) to self-hosted Supabase (Postgres) for lower latency, higher throughput, and full infrastructure ownership.

## Decisions

- **Staged dev cutover**: migrate one vertical slice at a time in dev, verify it, then move to the next slice. Production still gets a final cutover only after the Supabase path is complete.
- **No Redis**: receiver writes directly to Postgres (Strategy A, no batching)
- **No ClickHouse**: Postgres handles search and request listing; remove all ClickHouse code
- **No partitioning**: single `requests` table, cleanup via scheduled DELETE
- **Outside-in migration order**: auth first, receiver last
- **RLS on all tables**: defense-in-depth, receiver uses service role to bypass
- **Comprehensive testing**: unit, integration, and Playwright e2e tests per phase
- **No new Redis work during migration**: Redis is legacy infrastructure until the receiver rewrite lands. Do not add new Redis-based features or transitional systems.
- **No dedup**: the 2-second Redis dedup for Cloudflare edge retries is intentionally dropped — Postgres UNIQUE constraints or application-level idempotency can be added later if duplicate delivery becomes a problem in practice
- **No FK on `requests.endpoint_id`**: intentional — avoids FK lookup overhead on every INSERT in the hot path. Orphaned requests from deleted endpoints are cleaned up by the retention cron.
- **Fresh start for prod data**: existing Convex users re-register. API keys invalidated. Blog posts migrated via a one-time script. This is acceptable given the current low user count.
- **Free period lazy reset**: free user periods are reset lazily via `start_free_period()` on next request, not via a scheduled job. `pg_cron` billing reset only processes pro users.

## Infrastructure

| Service | Host | Port | Purpose |
|---|---|---|---|
| Supabase (Postgres) | 192.168.0.247 | 5433 (direct), 5432 (session pooler), 6543 (txn pooler) | Primary data store |
| Kong API Gateway | 192.168.0.247 | 8000 | PostgREST, Auth, Realtime |
| Public URL | api1.webhooks.cc | 443 | Browser clients, OAuth callbacks |

## Schema

Live in Supabase. Migration file: `supabase/migrations/00001_initial_schema.sql`

Tables: `users`, `endpoints`, `requests`, `api_keys`, `device_codes`, `blog_posts`

Key design choices:
- `users.id` references `auth.users(id)` — Supabase Auth is the identity source
- `requests.user_id` denormalized from endpoint for RLS and cleanup queries
- `check_and_decrement_quota()` — atomic quota check in a single SQL call; returns empty result set when quota exceeded (receiver must handle this as "quota exceeded")
- `start_free_period()` — idempotent lazy period activation
- `handle_new_user()` trigger auto-provisions `public.users` on OAuth signup

**Schema additions needed** (apply via `00002_additional_functions.sql`):
- `check_and_increment_ephemeral(p_endpoint_id uuid)` — atomic request_count check + increment for guest ephemeral endpoints (cap at 25)
- Composite index `(plan, period_end)` on `users` for billing reset cron efficiency

## Test Infrastructure

- Integration tests run against the real Supabase dev instance at 192.168.0.247
- Playwright e2e tests run against local Next.js dev server connected to the same Supabase instance
- Receiver integration tests run against the same Supabase Postgres
- CI: tests run against the same dev Supabase (not Docker-based); prod uses a separate clean instance

## Execution Strategy (revised 2026-03-13)

The migration will proceed in narrow vertical slices instead of a single broad pass.

1. **Close out Phase 1** — Treat auth as functionally complete in dev once the auth tests pass and the remaining work is documentation and cleanup, not new auth behavior.
2. **Start with the control plane** — Migrate API key validation, device auth, endpoint CRUD, and usage APIs before touching request search, dashboard realtime, or the receiver.
3. **Keep the next slice small** — The first post-auth phase must not include request search, billing, receiver ingestion, or general Convex cleanup. Those are separate phases.
4. **Preserve the end state** — The final architecture remains Supabase/Postgres without Redis or ClickHouse, but those removals happen when the receiver and request path are migrated, not before.
5. **Use contract checks** — For API routes used by the CLI, SDK, and MCP, preserve current request/response shapes while swapping the backend implementation.

Companion execution plan for the next slice:

- `docs/superpowers/plans/2026-03-13-phase2-control-plane-migration.md`

## Current Status (updated 2026-03-13)

- **Phase 1 is complete in dev**. Supabase auth is live, GitHub OAuth works in the dev app, and the auth closeout/env cleanup landed.
- **The original Phase 2 control-plane slice is complete**. API key validation, device auth, endpoint CRUD, usage reads, and `/cli/verify` no longer depend on Convex.
- **Request data migration is mostly complete on the web/API side**. `/api/endpoints/[slug]/requests`, `/api/requests/[id]`, `/api/search/requests`, `/api/search/requests/count`, the dashboard request list/detail path, and the dashboard endpoint management UI now use Supabase-backed routes and helpers.
- **Blog reads and admin writes are now split onto Supabase-backed web routes/helpers**. The blog index/post pages, blog preview, `feed.xml`, `sitemap-index.xml`, `sitemaps/blog.xml`, and the web app's `/api/blog` admin endpoints no longer depend on Convex storage.
- **Phase 2b is complete in dev on the web/API side**. Polar checkout, cancel, resubscribe, webhook handling, and account deletion now run through Supabase-backed web routes/helpers, and the account page billing UI no longer depends on Convex.
- **Billing period resets now run on Supabase**. A `pg_cron` job calls `process_billing_period_resets()` every minute in dev, replacing the old Convex billing reset cron behavior.
- **Phase 3 is mostly complete on the web/API path in dev**. The account page now updates live from the `users` row, the main dashboard request list/count updates from Supabase Realtime, and `/api/stream/[slug]` now bridges Supabase Realtime to SSE instead of Convex.
- **The guest `/go` live dashboard is now on Supabase too**. Guest endpoint creation, anonymous ephemeral reads, live request updates, and the guest endpoint creation rate limit no longer depend on Convex.
- **Receiver bridge work is in place for dev**. The branch includes Supabase-backed internal receiver control-plane routes plus receiver config support so endpoint creation, request capture, and quota enforcement can be exercised against the Supabase path in development before the full receiver rewrite.
- **Live dev validation completed**:
  - GitHub OAuth login works end-to-end.
  - Dashboard loads without Convex hooks.
  - Endpoint creation works.
  - Webhook capture works.
  - Usage/quota enforcement works.
  - Account billing state can upgrade, cancel, uncancel, and reset through the Supabase/Polar path.
  - Retained request search now runs on Postgres/Supabase in integration tests.
  - Blog admin writes work through `/api/blog`.
- **Still pending before the migration can close**:
  - Close the remaining Phase 2a cleanup items (primarily RLS/ownership verification and a few missing verification cases).
  - Finish the remaining account/API-key UI migration work.
  - Finish the remaining realtime Playwright verification.
  - Rewrite the receiver hot path and remove Redis/ClickHouse entirely.

---

## Phase 1: Auth Migration

**Goal**: users can log in with GitHub/Google via Supabase Auth, session persists across pages.

**Deliverables**:
- [x] Add `@supabase/supabase-js` and `@supabase/ssr` packages
- [x] Create `lib/supabase/client.ts` (browser client, anon key)
- [x] Create `lib/supabase/server.ts` (server client, cookie-based sessions)
- [x] Create `lib/supabase/admin.ts` (service role client, bypasses RLS)
- [x] Replace `convexAuthNextjsMiddleware` with Supabase SSR middleware
- [x] Update CSP middleware `connect-src` to include Supabase domains (replace `*.convex.cloud`/`*.convex.site`)
- [x] Rewire login page OAuth buttons to `supabase.auth.signInWithOAuth`
- [x] Rewire logout to `supabase.auth.signOut`
- [x] Verify `handle_new_user` trigger creates `public.users` row on first login
- [x] Account page shows correct user info from Supabase
- [x] Auth providers display (`getAuthProviders`) rewired to query `auth.identities` via service role

**Tests**:
- [x] Integration: sign up creates `public.users` row with correct email/name/image
- [x] Integration: `auth.uid()` matches `public.users.id` after login
- [x] Integration: auth providers query returns correct linked providers
- [x] Playwright e2e: GitHub OAuth login flow → redirects to dashboard
- [x] Playwright e2e: logout → redirects to login page
- [x] Playwright e2e: refresh page → session persists (no re-login)

**Completion**: complete in dev on 2026-03-13.

---

## Phase 2a: Data Layer — CRUD & Queries

**Goal**: all read/write operations for endpoints, requests, users, and blog posts use Supabase.

**Status**: in progress. Endpoint CRUD, usage reads, request list/detail, request search, device auth, the main dashboard request-management path, the guest `/go` flow, and the blog read/admin API surface are migrated. The remaining work is mostly verification and cleanup rather than missing product paths.

**Deliverables**:
- [ ] Replace `ConvexProvider`/`ConvexAuthProvider` in app layout with Supabase context (if needed)
- [x] Rewrite endpoint CRUD (list, create, get, update, delete) using Supabase client
- [x] Add rate limiting for endpoint creation (Postgres-based or in-memory token bucket) — per-user (10/10min) and anonymous (20/10min)
- [x] Rewrite request listing/detail using Supabase client
- [x] Rewrite request search (replace ClickHouse-backed `/api/search/requests` and `/api/search/requests/count` with Postgres queries)
- [x] Rewrite user profile/usage queries
- [ ] Rewrite API routes under `app/api/` to use Supabase service role client:
  - `[x] /api/endpoints` (CRUD + PATCH)
  - `[x] /api/endpoints/[slug]/requests`
  - `[x] /api/requests/[id]`
  - `[x] /api/usage`
  - `[x] /api/search/requests` and `/api/search/requests/count`
  - `[x] /api/auth/device-*` (device code, authorize, poll, claim)
  - `[x] /api/health`
  - `[x] /api/blog` and `/api/blog/[slug]` (blog admin API, `BLOG_API_SECRET` authenticated)
- [x] Blog post queries use Supabase client (published posts public via RLS)
- [x] Validate API route response shapes match what SDK/CLI expect (compare against SDK types)

**Tests**:
- [x] Integration: CRUD operations on endpoints (create, list, get, update, delete)
- [x] Integration: endpoint creation rate limiting enforced
- [x] Integration: request listing with pagination, filtering by endpoint
- [x] Integration: request search returns correct results
- [ ] Integration: RLS enforced — user A cannot see user B's endpoints/requests
- [x] Integration: ephemeral endpoints visible to unauthenticated users
- [x] Integration: API key validation (hash lookup, expiry check)
- [x] Integration: device auth flow (create code, authorize, poll, claim)
- [x] Integration: usage API returns correct used/remaining/limit
- [x] Playwright/manual dev: create endpoint → appears in dashboard
- [ ] Playwright e2e: delete endpoint → disappears from dashboard
- [ ] Playwright e2e: view request detail page

**Completion**: all tests pass, commit and mark phase complete.

---

## Phase 2b: Data Layer — Billing & Account Management

**Goal**: billing flows (Polar checkout, cancel, resubscribe), webhook handling, and account deletion work via Supabase.

**Status**: complete in dev for the web/API path. The remaining unverified item is full Playwright/live sandbox coverage.

**Deliverables**:
- [x] Rewrite billing mutations (Polar checkout, cancel, resubscribe) using Supabase admin client
- [x] Rewrite Polar webhook handler with all event types (subscription.created/updated/canceled/uncanceled/revoked/active, customer.*, order.*)
- [x] Account deletion: call `supabase.auth.admin.deleteUser()` which cascades to `public.users` via FK. Add cleanup for orphaned requests (no FK on requests table).
- [x] Account page shows usage stats, billing status, cancel/resubscribe buttons

**Tests**:
- [x] Integration: Polar webhook `subscription.created` upgrades user to pro with correct period
- [x] Integration: Polar webhook `subscription.canceled` sets `cancel_at_period_end`
- [x] Integration: Polar webhook `subscription.revoked` downgrades to free, resets usage
- [x] Integration: account deletion cascades to endpoints, api_keys, device_codes
- [x] Integration: account deletion cleans up orphaned requests
- [ ] Playwright e2e: account page shows correct plan/usage
- [ ] Playwright e2e: cancel subscription flow (if testable with sandbox)

**Completion**: integration coverage is complete on this branch. Playwright/live sandbox coverage can be added as follow-up verification.

---

## Phase 3: Real-time

**Goal**: dashboard updates live when webhooks arrive. CLI SSE streaming works.

**Deliverables**:
- [x] Subscribe to `postgres_changes` on `requests` table filtered by `endpoint_id`
- [x] Dashboard request list updates without page refresh on new webhook
- [x] SSE endpoint (`/api/stream/[slug]`) rewired to Supabase Realtime → SSE
- [x] Request count badge updates in real-time
- [x] Account plan/usage/subscription status updates in real-time from `users`
- [x] Guest `/go` live dashboard updates from Supabase without Convex hooks

**Tests**:
- [x] Integration: insert request via admin client, verify Realtime channel fires INSERT event
- [x] Integration: update user row via admin client, verify account-facing Realtime channel fires UPDATE event
- [x] Integration: SSE endpoint streams new requests as they arrive
- [ ] Playwright e2e: open dashboard, curl a webhook to the endpoint, verify request appears live
- [ ] Playwright e2e: verify request count updates without refresh

**Completion**: all tests pass, commit and mark phase complete.

---

## Phase 4: Cron Jobs

**Goal**: automated cleanup of expired data, billing period resets.

**Deliverables**:
- [x] Install/enable `pg_cron` extension in Supabase Postgres
- [ ] Schedule: `cleanup_old_requests()` daily at 01:00 UTC
- [ ] Schedule: `cleanup_free_user_requests()` daily at 01:30 UTC
- [x] Schedule: expired ephemeral endpoint cleanup every 5 minutes
- [ ] Schedule: expired device code cleanup every 5 minutes
- [ ] Schedule: expired API key cleanup daily at 02:00 UTC
- [x] Schedule: billing period reset every minute
- [x] Write billing period reset SQL: downgrade canceled pro users to free, reset usage and advance period for active pro users

**Tests**:
- [x] Integration: insert expired ephemeral endpoint, run cleanup, verify endpoint + its requests deleted
- [ ] Integration: insert expired device code, run cleanup, verify deleted
- [ ] Integration: insert free user requests older than 7 days, run cleanup, verify deleted
- [ ] Integration: insert requests older than 31 days, run cleanup, verify deleted
- [x] Integration: pro user with `cancel_at_period_end` + expired period, run billing reset, verify downgraded to free with usage reset
- [x] Integration: active pro user with expired period, run billing reset, verify usage reset and new period started

**Completion**: all tests pass, commit and mark phase complete.

---

## Phase 5: Receiver Rewrite

**Goal**: Rust receiver writes directly to Postgres. No Redis, no ClickHouse, no flush workers, no Convex.

**Deliverables**:
- [ ] Apply `00002_additional_functions.sql`: add `check_and_increment_ephemeral()` function
- [ ] Add `sqlx` with Postgres support to receiver `Cargo.toml`
- [ ] Create `src/db/pool.rs` — PgPool initialization from `SUPABASE_DB_URL` (default pool size: 20, configurable via env)
- [ ] Create `src/db/queries.rs` — prepared statements for hot path
- [ ] Rewrite `src/handlers/webhook.rs`:
  - Endpoint lookup via Postgres
  - Guest ephemeral: call `check_and_increment_ephemeral(endpoint_id)` — empty result = cap reached (reject with 429)
  - User-owned: call `check_and_decrement_quota(user_id)` — empty result = quota exceeded (reject with 429). If period expired for free user, call `start_free_period(user_id)` first, then retry quota check.
  - INSERT into `requests` table with `user_id` from endpoint lookup
  - Return mock response (or default 200 OK)
  - Increment `endpoints.request_count` (fire-and-forget UPDATE, non-blocking)
- [ ] Delete Redis code: `src/redis/` directory
- [ ] Delete ClickHouse code: `src/clickhouse/` directory, `src/handlers/search.rs`, `src/workers/clickhouse_retention.rs`
- [ ] Delete flush workers: `src/workers/flush.rs`, `src/workers/cache_warmer.rs`
- [ ] Delete Convex client: `src/convex/client.rs`, `src/convex/circuit_breaker.rs`
- [ ] Delete cache invalidation handler: `src/handlers/cache_invalidate.rs`
- [ ] Update `src/config.rs`: replace Redis/ClickHouse/Convex env vars with `SUPABASE_DB_URL` and `DB_POOL_SIZE`
- [ ] Update health check to verify Postgres connectivity

**Connection pool behavior**: pool size configurable via `DB_POOL_SIZE` env var (default 20). When pool is exhausted, requests wait up to 5 seconds for a connection, then return 503. This is graceful degradation — no dropped requests, just backpressure.

**Tests**:
- [ ] Rust unit tests: handler logic for each path (guest ephemeral, user-owned, expired endpoint, quota exceeded, free period start)
- [ ] Rust integration tests: send HTTP requests to receiver, verify rows in Postgres
- [ ] Integration: quota enforcement — send requests until quota exceeded, verify 429
- [ ] Integration: ephemeral endpoint — send 26 requests, verify 25 accepted + 1 rejected
- [ ] Integration: free user period — verify period starts on first request, quota resets
- [ ] Integration: mock response — configure mock response, send webhook, verify response matches
- [ ] Integration: pool exhaustion — verify 503 returned when all connections busy
- [ ] Load test: `oha` against receiver, verify ~10k+ RPS sustained with 0 errors
- [ ] Playwright e2e: send webhook via curl → verify appears in dashboard (full pipeline)

**Completion**: all tests pass, commit and mark phase complete.

---

## Phase 6: CLI / SDK / MCP Verification

**Goal**: verify all consumers work against the new backend. Fix any response shape mismatches found.

**Deliverables**:
- [ ] Run existing SDK test suite against new API routes
- [ ] Run existing MCP tool tests against new backend
- [ ] Fix any API route response shape mismatches discovered

**Tests**:
- [ ] SDK: `endpoints.create/get/list/delete` work
- [ ] SDK: `requests.list/waitFor` work
- [ ] SDK: `requests.subscribe` (SSE) streams live data
- [ ] CLI: `whk auth login` → `whk auth status` → `whk auth logout`
- [ ] CLI: `whk create` → `whk list` → `whk delete`
- [ ] CLI: `whk tunnel <port>` forwards webhooks to localhost
- [ ] CLI: `whk listen <slug>` streams incoming requests
- [ ] MCP: all 11 tools return expected results

**Completion**: all tests pass, commit and mark phase complete.

---

## Phase 7: Convex Removal & Final Verification

**Goal**: remove all Convex dependencies. Codebase compiles and all tests pass with zero Convex code.

**Deliverables**:
- [ ] Delete `convex/` directory
- [ ] Remove `@convex-dev/auth`, `convex`, `@convex-dev/rate-limiter` from `package.json`
- [ ] Remove `ConvexProvider`/auth wrappers from app layout (if not already done)
- [ ] Remove Convex/Redis/ClickHouse env vars from `.env.local`
- [ ] Remove Convex-related CI steps from `.github/workflows/ci.yml`
- [ ] Update `CLAUDE.md` to reflect new architecture (single Postgres backend, no Redis, no ClickHouse)
- [ ] Update `turbo.json` if needed
- [ ] One-time blog post migration script (export from Convex, insert into Supabase)

**Tests**:
- [ ] `pnpm build` succeeds with zero Convex imports
- [ ] `pnpm typecheck` succeeds
- [ ] `pnpm lint` passes
- [ ] Full Playwright e2e suite passes
- [ ] Full SDK/CLI/MCP test suite passes
- [ ] `cargo build --release` succeeds for receiver
- [ ] `cargo test` passes for receiver

**Completion**: all tests pass, final commit, branch ready for prod cutover.
