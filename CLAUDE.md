# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

webhooks.cc is a production webhook inspection and testing service. Users capture incoming webhooks, inspect request details, configure mock responses, and forward requests to localhost via CLI tunneling. The service includes a TypeScript SDK (`@webhooks-cc/sdk`) for programmatic access and test assertions, and an MCP server (`@webhooks-cc/mcp`) for AI coding agent integration.

**Production URLs:**

- App: `https://webhooks.cc`
- Webhook receiver: `https://go.webhooks.cc`

## Commands

### Development

```bash
pnpm install              # Install all dependencies
pnpm dev:web              # Start Next.js web app
make dev-receiver         # Start Rust webhook receiver
make dev-cli ARGS="..."   # Run CLI with arguments
```

### Build & Verify

```bash
pnpm build                # Build all TypeScript packages (turbo)
pnpm typecheck            # Type check all packages (turbo)
make build                # Build everything including binaries
make build-receiver       # Build Rust receiver (release) to dist/receiver
make build-cli            # Build CLI with goreleaser
```

**CRITICAL**: After building, you MUST restart the service. Use the deploy targets which build + restart atomically:

```bash
make deploy-receiver    # Build Rust receiver + restart service
make deploy-web         # Build Next.js + restart service
make deploy-all         # Deploy both
```

Without restarting, the old binary/build continues running and code changes have no effect.

### Test

```bash
make test                           # Run all tests (TS + Go + Rust)
cd apps/web && npx vitest run tests/integration/  # Supabase integration tests (42 cases)
cd apps/receiver-rs && cargo test   # Rust receiver tests
cd apps/cli && go test ./...        # CLI tests only
```

### Supabase

Migrations live in `supabase/migrations/`. Apply to the dev instance:

```bash
psql "$SUPABASE_DB_URL" -f supabase/migrations/00010_capture_webhook.sql
```

### Systemd Services

Both the web app and receiver run as **user** systemd services (no `sudo` needed). Service files live at `~/.config/systemd/user/webhooks-{web,receiver}.service`.

```bash
# Manage services
make prod-status                  # Check both services
make prod-restart                 # Restart both services
make prod-stop                    # Stop both services

# Individual service control
systemctl --user restart webhooks-receiver
systemctl --user restart webhooks-web
systemctl --user status webhooks-receiver webhooks-web

# Logs
journalctl --user -u webhooks-receiver -f                       # Follow receiver logs
journalctl --user -u webhooks-web -f                            # Follow web logs
journalctl --user -u webhooks-receiver --since "5 minutes ago"  # Recent logs
```

### Production Log Viewer

```bash
make prod                 # Ensure services are running + open mprocs log viewer
pnpm start                # Same via pnpm (mprocs --config mprocs.yaml)
```

`mprocs.yaml` tails both service journals side-by-side. It is a **log viewer only** — it does not manage the processes.

### Lint & Format

```bash
pnpm lint                 # ESLint across all packages
pnpm format:check         # Prettier check
pnpm format               # Prettier fix
cd apps/receiver-rs && cargo clippy     # Rust receiver lint
```

## Architecture

### Service Layout

| Service   | Port | Stack                                | Purpose                                              |
| --------- | ---- | ------------------------------------ | ---------------------------------------------------- |
| Web app   | 3000 | Next.js 16, React 19, Tailwind v4    | Dashboard, docs, landing page, API routes            |
| Receiver  | 3001 | Rust (Axum, Tokio, sqlx/Postgres)    | Captures webhooks at `/w/{slug}`                     |
| Collector | 8099 | AppSignal Collector (Rust binary)    | Receives OTel traces from receiver, host metrics     |
| Supabase  | —    | Self-hosted Postgres, Auth, Realtime | Database, auth, real-time subscriptions              |
| CLI       | n/a  | Go 1.25, Cobra                       | `whk tunnel`, `whk listen`, device auth              |
| SDK       | n/a  | TypeScript, tsup                     | `@webhooks-cc/sdk` on npm                            |
| MCP       | n/a  | TypeScript, tsup                     | `@webhooks-cc/mcp` on npm — MCP server for AI agents |

### Directory Structure

```
webhooks-cc/
├── apps/
│   ├── web/              # Next.js 16 App Router (Tailwind v4, shadcn/ui, AppSignal)
│   ├── receiver-rs/      # Rust Axum webhook receiver (direct Postgres via sqlx)
│   ├── cli/              # Go Cobra CLI (cmd/whk + internal packages)
│   └── go-shared/        # Shared Go types (types/types.go)
├── packages/
│   ├── sdk/              # @webhooks-cc/sdk (TypeScript, tsup, vitest)
│   └── mcp/              # @webhooks-cc/mcp (MCP server for AI agents)
├── supabase/
│   └── migrations/       # Postgres schema, functions, RLS policies, cron jobs
├── docs/                 # Internal planning docs (gitignored)
├── .github/workflows/    # CI, CLI release, SDK publish
├── Makefile              # Build/dev/test orchestration
├── turbo.json            # Monorepo task config
├── docker-compose.yml    # Docker setup (web + receiver)
└── pnpm-workspace.yaml   # pnpm workspaces: apps/*, packages/*
```

### Data Flow

```
External service -> POST /w/{slug}/path
  -> Rust Receiver:
     1. Validate slug, extract headers/body/IP
     2. Call capture_webhook() stored procedure (single Postgres RPC)
        - Look up endpoint, check expiry
        - Check/decrement quota atomically
        - INSERT request row
        - Increment counters
     3. Return mock response (if configured) or 200 OK
  -> Dashboard: real-time update via Supabase Realtime (postgres_changes)
  -> CLI: SSE stream at /api/stream/{slug} -> forward to localhost
```

### Receiver Internals (Rust)

The Rust receiver (`apps/receiver-rs/`) handles all webhook ingestion. It connects directly to Postgres via sqlx — no Redis, no intermediary services.

**Architecture:**

- **Axum + Tokio**: Async HTTP server
- **sqlx + Postgres**: Direct database access via connection pool
- **Single stored procedure**: `capture_webhook()` handles endpoint lookup, quota, insert, and counters in one transaction
- **Fail-open**: On DB errors, returns 200 OK to avoid dropping webhooks from the sender's perspective

**Source files (`src/`):**

- `main.rs` — Axum setup, PgPool creation, route registration, tracing
- `config.rs` — Env var loading (`DATABASE_URL`, `CAPTURE_SHARED_SECRET`, `PORT`, pool sizing)
- `handlers/webhook.rs` — Hot path: call stored procedure, map result to HTTP response
- `handlers/health.rs` — Pool connectivity check

**Webhook handler pipeline:**

1. Extract slug, method, path, headers, body, query params, client IP
2. Validate slug format (`^[A-Za-z0-9_-]{1,50}$`)
3. Filter proxy headers (Cloudflare, Caddy, X-Forwarded-\*)
4. Call `SELECT capture_webhook(slug, method, path, headers, body, query_params, content_type, ip, received_at)`
5. Map result status to HTTP response:
   - `ok` + mock_response → build mock HTTP response (with security header blocking, CRLF validation)
   - `ok` → 200 "ok"
   - `not_found` → 404
   - `expired` → 410
   - `quota_exceeded` → 429 with Retry-After header
6. On DB error → 200 "ok" (fail open)

**Receiver env vars:**

| Variable                  | Required | Default | Purpose                                                              |
| ------------------------- | -------- | ------- | -------------------------------------------------------------------- |
| `DATABASE_URL`            | yes      |         | Postgres connection string (use session pooler)                      |
| `CAPTURE_SHARED_SECRET`   | yes      |         | Shared secret (kept for future internal auth)                        |
| `PORT`                    | no       | 3001    | Listen port                                                          |
| `RECEIVER_DEBUG`          | no       |         | Enable debug logging                                                 |
| `RECEIVER_LOG_DIR`        | no       | logs/   | Rolling JSON log file directory                                      |
| `PG_POOL_MIN`             | no       | 5       | Min Postgres pool connections                                        |
| `PG_POOL_MAX`             | no       | 20      | Max Postgres pool connections                                        |
| `APPSIGNAL_COLLECTOR_URL` | no       |         | OTLP endpoint for AppSignal collector (e.g. `http://localhost:8099`) |

### CLI Commands

| Command             | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `whk auth login`    | Device auth flow (browser-based, generates 90-day API key) |
| `whk auth status`   | Show current login status                                  |
| `whk auth logout`   | Clear stored token                                         |
| `whk tunnel <port>` | Create endpoint + forward webhooks to localhost            |
| `whk listen <slug>` | Stream incoming requests to terminal                       |
| `whk create [name]` | Create a new endpoint                                      |
| `whk list`          | List user's endpoints                                      |
| `whk delete <slug>` | Delete an endpoint                                         |
| `whk replay <id>`   | Replay a captured request                                  |
| `whk update`        | Self-update from GitHub releases (SHA256 verified)         |

Config stored at `~/.config/whk/token.json`. Override API URL with `WHK_API_URL` env var. Debug logging via `WHK_DEBUG`.

### Supabase Backend

**Schema (6 tables + auth system):**

| Table          | Key fields                                                                          | Notes                                                 |
| -------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `users`        | email, plan (free/pro), requests_used, request_limit, polar_customer_id, period_end | Indexes: email, polar_customer, plan, plan+period_end |
| `endpoints`    | slug (unique), user_id?, mock_response (jsonb)?, is_ephemeral, expires_at?          | Indexes: slug, user, expires, ephemeral+expires       |
| `requests`     | endpoint_id, user_id, method, path, headers (jsonb), body, ip, received_at          | Indexes: endpoint+time, user+time, received_at        |
| `api_keys`     | user_id, key_hash (SHA-256), key_prefix, expires_at                                 | Indexes: key_hash, user                               |
| `device_codes` | device_code, user_code, status, user_id?, expires_at                                | Indexes: device_code, user_code, status               |
| `blog_posts`   | slug (unique), title, content, status (draft/published)                             | Index: slug, status                                   |

**Key stored procedures:**

| Function                             | Purpose                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `capture_webhook()`                  | Hot path: endpoint lookup + quota + insert + counters in one call       |
| `check_and_decrement_quota()`        | Atomic quota check + decrement for owned endpoints                      |
| `check_and_increment_ephemeral()`    | Atomic request count check + increment for ephemeral endpoints (25 cap) |
| `start_free_period()`                | Lazy 24h period activation for free users                               |
| `increment_endpoint_request_count()` | Increment endpoint counter                                              |
| `increment_user_requests_used()`     | Increment user usage counter                                            |

**RLS policies:** All tables have row-level security enabled. Anonymous access is blocked on all tables except `blog_posts` (published only) and `endpoints` INSERT (ephemeral with bounded expiry only). Guest endpoint/request reads are mediated through server API routes using the service role.

**Cron jobs (via pg_cron):**

| Job                         | Schedule        | Purpose                                                                  |
| --------------------------- | --------------- | ------------------------------------------------------------------------ |
| Billing period resets       | Every minute    | Reset free (24h) and pro (30d) periods, downgrade canceled subscriptions |
| Ephemeral endpoint cleanup  | Every 5 min     | Delete expired ephemeral endpoints and orphaned requests                 |
| Expired device code cleanup | Every 5 min     | Delete expired CLI login codes                                           |
| Free user request cleanup   | Daily 01:30 UTC | Delete requests older than 7 days for free users                         |
| Old request cleanup         | Daily 01:00 UTC | Delete all requests older than 31 days                                   |
| Expired API key cleanup     | Daily 02:00 UTC | Delete expired API keys                                                  |

**Key patterns:**

- The receiver writes directly to Postgres via `capture_webhook()` — no intermediary
- Usage increments happen atomically inside the stored procedure (no race conditions)
- Free user periods activate lazily on first request via `start_free_period()`
- Supabase Auth handles GitHub + Google OAuth with auto-provisioning via `handle_new_user()` trigger
- API keys use SHA-256 hashed storage with `whcc_` prefix, validated by hash lookup
- Device auth flow: create → authorize → poll → claim (API key generated at claim time)
- Sensitive routes (account deletion, billing mutations) require Supabase session tokens — API keys are rejected

### Web App Structure

Next.js 16 App Router with neobrutalism design (Space Grotesk + JetBrains Mono fonts).

**Public routes:** `/` (landing), `/docs/*` (10 doc pages incl. MCP), `/installation` (CLI/SDK/MCP tabs), `/login`, `/privacy`, `/terms`, `/support`

**Authenticated routes:** `/dashboard` (split-pane request viewer), `/account` (profile, billing, API keys), `/endpoints/new`, `/endpoints/[slug]/settings`, `/cli/verify` (device auth)

**API routes:** `/api/health`, `/api/auth/device-*` (4 routes), `/api/endpoints` (CRUD + PATCH), `/api/endpoints/[slug]/requests`, `/api/requests/[id]`, `/api/stream/[slug]` (SSE), `/api/api-keys` (CRUD), `/api/account` (DELETE), `/api/billing/*` (checkout/cancel/resubscribe), `/api/go/endpoint/*` (guest dashboard reads)

**Key directories:**

- `app/` - Pages and API routes
- `components/` - UI components organized by feature (dashboard/, landing/, billing/, auth/, nav/, ui/)
- `lib/` - Utilities: env validation (zod), API auth, rate limiting, formatting, SEO, export (JSON/CSV)
- `lib/supabase/` - Supabase client utilities: admin (service role), client (browser), server (SSR), api-keys, billing, endpoints, requests, device-auth, cleanup, realtime, search

### SDK

`@webhooks-cc/sdk` v0.3.0 - published to npm, MIT licensed.

```typescript
const client = new WebhooksCC({ apiKey: "whcc_..." });
const endpoint = await client.endpoints.create({ name: "test" });
const req = await client.requests.waitFor(endpoint.slug, {
  timeout: "30s",
  match: matchAll(matchMethod("POST"), matchHeader("stripe-signature")),
});
```

**Key methods:**

- `endpoints.create/get/list/delete` — CRUD
- `endpoints.update(slug, opts)` — rename, set/clear mock response
- `endpoints.send(slug, {method, headers, body})` — send test webhook
- `requests.list/waitFor` — list and poll for captured requests
- `requests.replay(id, targetUrl)` — replay a captured request to any URL
- `requests.subscribe(slug)` — SSE async iterator for real-time streaming
- `client.describe()` — self-documenting introspection for AI agents

**Exports:** `WebhooksCC`, `ApiError`, error classes (`WebhooksCCError`, `UnauthorizedError`, `NotFoundError`, `TimeoutError`, `RateLimitError`), matchers (`matchMethod`, `matchHeader`, `matchBodyPath`, `matchAll`, `matchAny`), helpers (`parseJsonBody`, `isStripeWebhook`, `isGitHubWebhook`, `isShopifyWebhook`, `isSlackWebhook`, `isTwilioWebhook`, `isPaddleWebhook`, `isLinearWebhook`, `matchJsonField`), utilities (`parseDuration`, `parseSSE`).

**Features:** Human-readable duration strings (`"30s"`, `"5m"`) for `timeout`/`pollInterval`, actionable error messages with recovery hints, lifecycle hooks (`onRequest`, `onResponse`, `onError`).

### MCP Server

`@webhooks-cc/mcp` v0.1.0 - MCP server for AI coding agents, MIT licensed.

- 11 tools: `create_endpoint`, `list_endpoints`, `get_endpoint`, `update_endpoint`, `delete_endpoint`, `list_requests`, `get_request`, `send_webhook`, `wait_for_request`, `replay_request`, `describe`
- Setup CLI: `npx @webhooks-cc/mcp setup <tool>` for Cursor, VS Code, Windsurf, Claude Desktop
- Native install: `claude mcp add` (Claude Code), `codex mcp add` (Codex)
- Transport: stdio via `@modelcontextprotocol/sdk`
- Depends on `@webhooks-cc/sdk` (workspace link)

**Key files (`packages/mcp/src/`):**

- `index.ts` — MCP server setup, tool registration, stdio transport
- `tools.ts` — Tool definitions with Zod schemas and handlers
- `setup.ts` — CLI setup commands for various AI tools
- `bin/mcp.js` — Binary entry point (`npx` / `webhooks-cc-mcp`)

## Environment Variables

### Root `.env.local` (shared)

| Variable                        | Required | Purpose                                           |
| ------------------------------- | -------- | ------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | yes      | Supabase project URL                              |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes      | Supabase public anon key                          |
| `SUPABASE_URL`                  | yes      | Supabase project URL (server-side)                |
| `SUPABASE_SERVICE_ROLE_KEY`     | yes      | Supabase service role key                         |
| `SUPABASE_DB_URL`               | yes      | Direct Postgres connection string                 |
| `DATABASE_URL`                  | yes      | Postgres connection for receiver (session pooler) |
| `NEXT_PUBLIC_WEBHOOK_URL`       | yes      | Webhook receiver base URL                         |
| `NEXT_PUBLIC_APP_URL`           | yes      | App base URL                                      |
| `CAPTURE_SHARED_SECRET`         | yes      | Shared secret for internal auth                   |

### Supabase Environment

| Variable                | Purpose                        |
| ----------------------- | ------------------------------ |
| `POLAR_ACCESS_TOKEN`    | Polar.sh API                   |
| `POLAR_ORGANIZATION_ID` | Polar org                      |
| `POLAR_WEBHOOK_SECRET`  | Webhook signature verification |
| `POLAR_PRO_PRODUCT_ID`  | Product ID for checkout        |
| `POLAR_PRO_PRICE_ID`    | Price ID for checkout          |
| `POLAR_SANDBOX`         | `true` for sandbox mode        |
| `BLOG_API_SECRET`       | Blog admin API auth            |

### Optional

| Variable                      | Purpose                                         |
| ----------------------------- | ----------------------------------------------- |
| `APPSIGNAL_PUSH_API_KEY`      | AppSignal API key (web app)                     |
| `APPSIGNAL_APP_NAME`          | AppSignal app name (default: `webhooks-cc-web`) |
| `APPSIGNAL_COLLECTOR_URL`     | OTel collector URL for receiver                 |
| `RECEIVER_DEBUG`              | Enable receiver debug logging                   |
| `WHK_DEBUG`                   | Enable CLI debug logging                        |
| `PG_POOL_MIN` / `PG_POOL_MAX` | Receiver connection pool sizing                 |

## CI/CD & Releases

- **CI** (`.github/workflows/ci.yml`): lint, typecheck, build-web, build-go, test-go, lint-go, build-rust, test-rust, lint-rust
- **CLI release** (`cli-release.yml`): triggered by `v*` tags, GoReleaser builds for linux/darwin/windows (amd64/arm64), cosign keyless signing, Homebrew tap publish
- **SDK publish** (`sdk-publish.yml`): triggered by `sdk-v*` tags, publishes `@webhooks-cc/sdk` to npm
- **MCP publish**: triggered by `mcp-v*` tags, publishes `@webhooks-cc/mcp` to npm
- **Security**: Dependabot, CodeQL analysis

## Changelog & Versioning

The web app version and changelog live in `apps/web/lib/changelog.ts`. The changelog page is at `/changelog`, linked from the footer and account page.

The changelog has 4 tracks: `web`, `cli`, `sdk`, `mcp`. Each entry has a `track` field. Version constants: `APP_VERSION`, `CLI_VERSION`, `SDK_VERSION`, `MCP_VERSION`.

**When merging a PR to main** (web app changes):

1. **Bump `APP_VERSION`** in `apps/web/lib/changelog.ts` and `version` in `apps/web/package.json`:
   - Patch bump (0.9.1 → 0.9.2): bug fixes, small features, doc updates
   - Minor bump (0.9.x → 0.10.0): significant new features, new integrations
   - Major bump: reserved for 1.0 launch
2. **Add a new entry** with `track: "web"` to the top of the web section in the `CHANGELOG` array
3. Keep entries concise — focus on user-facing changes, not internal refactors

**When publishing a CLI release** (`v*` tag):

1. **Bump `CLI_VERSION`** in `apps/web/lib/changelog.ts`
2. **Add a new entry** with `track: "cli"` to the top of the CLI section in the `CHANGELOG` array

**When publishing an SDK release** (`sdk-v*` tag):

1. **Bump `SDK_VERSION`** in `apps/web/lib/changelog.ts`
2. **Add a new entry** with `track: "sdk"` to the top of the SDK section in the `CHANGELOG` array

**When publishing an MCP release** (`mcp-v*` tag):

1. **Bump `MCP_VERSION`** in `apps/web/lib/changelog.ts`
2. **Add a new entry** with `track: "mcp"` to the top of the MCP section in the `CHANGELOG` array

## Key Gotchas

- The Rust receiver connects directly to Postgres via `DATABASE_URL` — use the Supabase session pooler URL, not the direct connection
- Receiver fails open on DB errors: returns 200 OK so webhook senders don't retry
- Mock response changes take effect immediately (no caching layer)
- Free user billing periods are lazy: `period_end` is unset until first request triggers `start_free_period()`
- RLS is hardened: anonymous users cannot read endpoints, requests, or device codes directly — all guest reads go through server API routes with service role
- Sensitive routes (account deletion, billing) require Supabase session tokens — API keys return 403
- Supabase migrations are in `supabase/migrations/` and must be applied manually to the dev instance via psql

## Licensing

Split license model:

- **AGPL-3.0**: `apps/web`, `apps/receiver-rs`, `supabase/`
- **MIT**: `apps/cli`, `packages/sdk`, `packages/mcp`, `apps/go-shared`
