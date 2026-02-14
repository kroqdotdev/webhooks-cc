# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

webhooks.cc is a production webhook inspection and testing service. Users capture incoming webhooks, inspect request details, configure mock responses, and forward requests to localhost via CLI tunneling. The service includes a TypeScript SDK (`@webhooks-cc/sdk`) for programmatic access and test assertions, and an MCP server (`@webhooks-cc/mcp`) for AI coding agent integration.

**Production URLs:**

- App: `https://webhooks.cc`
- Webhook receiver: `https://go.webhooks.cc`
- Convex API: `https://api.webhooks.cc` (.cloud)
- Convex HTTP actions: `https://site.webhooks.cc` (.site)

## Commands

### Development

```bash
pnpm install              # Install all dependencies
pnpm dev:convex           # Start Convex backend (run first, in separate terminal)
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

**CRITICAL**: After `make build-receiver`, you MUST restart the systemd service:

```bash
make build-receiver && sudo systemctl restart webhooks-receiver
```

Without this step the old binary continues running and code changes have no effect.

### Test

```bash
make test                 # Run all tests (TS + Go + Rust)
pnpm test:convex          # Convex backend tests only (vitest, 58+ cases)
cd apps/receiver-rs && cargo test   # Rust receiver tests
cd apps/cli && go test ./...        # CLI tests only
```

### Convex

```bash
npx convex dev --once     # Push schema/functions to dev deployment
npx convex deploy         # Deploy to production
npx convex run <fn> '{}'  # Run a function
```

- Dev deployment: `dev:good-starfish-831`
- Prod deployment: `prod:affable-corgi-165`

### Systemd Services

The receiver runs as a systemd service. The service runs the Rust binary at `dist/receiver`.

```bash
sudo systemctl restart webhooks-receiver                      # Restart (applies rebuild)
sudo systemctl status webhooks-receiver                       # Check status
sudo journalctl -u webhooks-receiver -f                       # Follow logs
sudo journalctl -u webhooks-receiver --since "5 minutes ago"  # Recent logs
```

### Lint & Format

```bash
pnpm lint                 # ESLint across all packages
pnpm format:check         # Prettier check
pnpm format               # Prettier fix
cd apps/receiver-rs && cargo clippy     # Rust receiver lint
```

## Architecture

### Service Layout

| Service  | Port    | Stack                             | Purpose                                               |
| -------- | ------- | --------------------------------- | ----------------------------------------------------- |
| Web app  | 3000    | Next.js 16, React 19, Tailwind v4 | Dashboard, docs, landing page                         |
| Receiver | 3001    | Rust (Axum, Tokio, Redis)         | Captures webhooks at `/w/{slug}`                      |
| Convex   | managed | Convex 1.31                       | Database, auth, real-time subscriptions, HTTP actions |
| CLI      | n/a     | Go 1.25, Cobra                    | `whk tunnel`, `whk listen`, device auth               |
| SDK      | n/a     | TypeScript, tsup                  | `@webhooks-cc/sdk` on npm                             |
| MCP      | n/a     | TypeScript, tsup                  | `@webhooks-cc/mcp` on npm — MCP server for AI agents  |

### Directory Structure

```
webhooks-cc/
├── apps/
│   ├── web/              # Next.js 16 App Router (Tailwind v4, shadcn/ui, Sentry)
│   ├── receiver-rs/      # Rust Axum webhook receiver
│   ├── cli/              # Go Cobra CLI (cmd/whk + internal packages)
│   └── go-shared/        # Shared Go types (types/types.go)
├── packages/
│   ├── sdk/              # @webhooks-cc/sdk (TypeScript, tsup, vitest)
│   └── mcp/              # @webhooks-cc/mcp (MCP server for AI agents)
├── convex/               # Backend: schema, functions, HTTP actions, crons, tests
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
  -> Rust Receiver (hot path, ~0.3ms):
     1. Validate slug, extract headers/body/IP
     2. Fetch endpoint info from Redis cache (300s TTL, warmed proactively)
     3. Check quota via Redis Lua script (atomic decrement, no locks)
     4. Push request to Redis list buffer, mark slug active
     5. Return mock response immediately (if configured)
  -> Background flush workers (4x, async):
     1. Poll active slugs from Redis set
     2. Atomically take batch from Redis list (Lua script)
     3. POST to Convex /capture-batch (Bearer CAPTURE_SHARED_SECRET)
     4. At-most-once delivery (only re-enqueue on CircuitOpen)
  -> Convex HTTP action:
     1. Look up endpoint, check expiry
     2. Store request(s) in `requests` table
     3. Schedule usage increment (avoids OCC conflicts)
  -> Dashboard: real-time update via Convex reactive query
  -> CLI: SSE stream at /api/stream/{slug} -> forward to localhost
```

### Receiver Internals (Rust)

The Rust receiver (`apps/receiver-rs/`) handles all webhook ingestion. Benchmarked at ~86k RPS (oha), verified 100% delivery accuracy at 3.2k sustained RPS.

**Architecture:**

- **Axum + Tokio**: Async HTTP server, hot path returns in ~0.3ms (3 pipelined Redis commands)
- **Redis**: All state lives in Redis — endpoint cache, quota, request buffers, circuit breaker. Configured via `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB` env vars
- **No Convex on hot path**: Webhook capture never touches Convex directly, only Redis

**Key components (`src/`):**

- `handlers/webhook.rs` — Hot path: validate slug, check cache, check quota, buffer request
- `handlers/health.rs` — Health check endpoint
- `handlers/cache_invalidate.rs` — Convex calls this to invalidate cached endpoint/quota
- `redis/endpoint_cache.rs` — Endpoint info cache (300s TTL, proactively warmed)
- `redis/quota.rs` — Atomic quota check via Lua script (decrement + check in one call)
- `redis/request_buffer.rs` — Redis list per slug, atomic batch-take via Lua script
- `convex/client.rs` — HTTP client for Convex API (30s timeout, connection pooling)
- `convex/circuit_breaker.rs` — Redis-backed circuit breaker (5 failures → 30s cooldown)
- `workers/flush.rs` — 4 concurrent workers drain Redis buffers to Convex
- `workers/cache_warmer.rs` — Proactively refreshes endpoint/quota cache before TTL expiry
- `config.rs` — Env var loading

**Flush workers:**

- 4 workers, each processes a strided subset of shuffled slugs for fair distribution
- Atomic batch-take from Redis lists (Lua script with DEL when fully consumed)
- At-most-once delivery: only re-enqueue on `CircuitOpen` (request never sent)
- All other errors (network, server, client) drop the batch to avoid duplicates

**Redis data model:**

- `ep:{slug}` — Cached endpoint info (JSON, 300s TTL)
- `quota:{slug}` — Quota remaining/limit (hash, 300s TTL)
- `quota:user:{userId}` — Per-user shared quota across endpoints
- `buf:{slug}` — Request buffer (list, LPUSH new / LRANGE+DEL old)
- `buf:active` — Set of slugs with pending requests
- `cb:failures` / `cb:state` / `cb:last_failure` — Circuit breaker state

Receiver env vars: `CONVEX_SITE_URL`, `CAPTURE_SHARED_SECRET`, `PORT` (default 3001), `RECEIVER_DEBUG`, `REDIS_HOST` (default `127.0.0.1`), `REDIS_PORT` (default `6380`), `REDIS_PASSWORD`, `REDIS_DB` (default `0`)

**Requires Redis running** — configured via env vars in `.env.local` (default: `192.168.0.20:6379`)

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

### Convex Backend

**Schema (5 tables + auth system):**

| Table         | Key fields                                                                     | Notes                                            |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| `users`       | email, plan (free/pro), requestsUsed, requestLimit, polarCustomerId, periodEnd | Indexes: by_email, by_polar_customer, by_plan    |
| `endpoints`   | slug, userId?, mockResponse?, isEphemeral, expiresAt?                          | Indexes: by_slug, by_user, by_expires            |
| `requests`    | endpointId, method, path, headers, body, ip, receivedAt                        | Index: by_endpoint_time                          |
| `apiKeys`     | userId, keyHash (SHA-256), keyPrefix, expiresAt                                | Indexes: by_key_hash, by_user                    |
| `deviceCodes` | deviceCode, userCode, status, userId?, expiresAt                               | Indexes: by_device_code, by_user_code, by_status |

**Key files:**

| File             | Purpose                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.ts`      | Database schema definition                                                                                                                            |
| `http.ts`        | HTTP actions: `/capture`, `/capture-batch`, `/quota`, `/endpoint-info`, `/check-period`, `/validate-api-key`, `/cli/*`, `/polar-webhook`              |
| `auth.ts`        | GitHub + Google OAuth via @convex-dev/auth, cross-provider email linking                                                                              |
| `users.ts`       | `current` (public, filters Polar IDs), `currentFull` (internal, includes Polar IDs), `deleteAccount` with phased deletion                             |
| `endpoints.ts`   | CRUD with auth checks. Unauth users forced to `isEphemeral: true`. Schedules receiver cache invalidation on update                                    |
| `requests.ts`    | Capture, quota checking (lazy period activation for free users), cleanup crons                                                                        |
| `billing.ts`     | Polar.sh integration: checkout, cancel, resubscribe, webhook handling (HMAC-SHA256 verified)                                                          |
| `apiKeys.ts`     | SHA-256 hashed storage, `whcc_` prefix, O(1) validation by hash lookup, 1-year max TTL                                                                |
| `deviceAuth.ts`  | Device flow: create -> authorize -> poll -> claim (API key generated at claim time, one-time use)                                                     |
| `rateLimiter.ts` | Token bucket via @convex-dev/rate-limiter: ephemeral (50/10min), user creation (10/10min), anon creation (20/10min)                                   |
| `config.ts`      | Zod-validated env config: FREE_REQUEST_LIMIT (200), PRO_REQUEST_LIMIT (500k), EPHEMERAL_TTL_MS (10min), BILLING_PERIOD_MS (30d), FREE_PERIOD_MS (24h) |
| `crons.ts`       | Every 5min: cleanup expired endpoints + device codes. Daily: billing period resets, API key cleanup, old request cleanup (30d for pro)                |

**Key patterns:**

- `users.current` (public) filters out `polarCustomerId` and `polarSubscriptionId` - use `internal.users.currentFull` for server-side billing access
- Usage increments scheduled via `ctx.scheduler.runAfter(0, ...)` to avoid OCC read-modify-write races
- Large deletions (account, request cleanup) split into phases to stay under 10s mutation timeout
- Free user periods activate lazily on first request, not at signup
- All receiver/CLI HTTP actions require `CAPTURE_SHARED_SECRET` Bearer token (except OAuth routes and `/polar-webhook`)

### Web App Structure

Next.js 16 App Router with neobrutalism design (Space Grotesk + JetBrains Mono fonts).

**Public routes:** `/` (landing), `/docs/*` (10 doc pages incl. MCP), `/installation` (CLI/SDK/MCP tabs), `/login`, `/privacy`, `/terms`, `/support`

**Authenticated routes:** `/dashboard` (split-pane request viewer), `/account` (profile, billing, API keys), `/endpoints/new`, `/endpoints/[slug]/settings`, `/cli/verify` (device auth)

**API routes:** `/api/health`, `/api/auth/device-*` (3 routes), `/api/endpoints` (CRUD + PATCH), `/api/endpoints/[slug]/requests`, `/api/requests/[id]`, `/api/stream/[slug]` (SSE)

**Key directories:**

- `app/` - Pages and API routes
- `components/` - UI components organized by feature (dashboard/, landing/, billing/, auth/, nav/, ui/)
- `lib/` - Utilities: env validation (zod), API auth, rate limiting, formatting, SEO, export (JSON/CSV)

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

| Variable                  | Required | Purpose                                    |
| ------------------------- | -------- | ------------------------------------------ |
| `CONVEX_DEPLOYMENT`       | yes      | Convex deployment identifier               |
| `NEXT_PUBLIC_CONVEX_URL`  | yes      | Convex `.cloud` URL                        |
| `CONVEX_SITE_URL`         | yes      | Convex `.site` URL (HTTP actions)          |
| `NEXT_PUBLIC_WEBHOOK_URL` | yes      | Webhook receiver base URL                  |
| `NEXT_PUBLIC_APP_URL`     | yes      | App base URL                               |
| `CAPTURE_SHARED_SECRET`   | yes      | Shared secret for receiver <-> Convex auth |
| `REDIS_HOST`              | yes      | Redis host (e.g. `192.168.0.20`)           |
| `REDIS_PORT`              | yes      | Redis port (e.g. `6379`)                   |
| `REDIS_PASSWORD`          | yes      | Redis password                             |
| `REDIS_DB`                | yes      | Redis database number (e.g. `0`)           |

### Convex Environment (set via dashboard)

| Variable                | Purpose                        |
| ----------------------- | ------------------------------ |
| `CONVEX_SITE_URL`       | Auth config                    |
| `CAPTURE_SHARED_SECRET` | HTTP action auth               |
| `POLAR_ACCESS_TOKEN`    | Polar.sh API                   |
| `POLAR_ORGANIZATION_ID` | Polar org                      |
| `POLAR_WEBHOOK_SECRET`  | Webhook signature verification |
| `POLAR_PRO_PRODUCT_ID`  | Product ID for checkout        |
| `POLAR_PRO_PRICE_ID`    | Price ID for checkout          |
| `POLAR_SANDBOX`         | `true` for sandbox mode        |

### Optional

| Variable                                | Purpose                       |
| --------------------------------------- | ----------------------------- |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | Error tracking                |
| `RECEIVER_DEBUG`                        | Enable receiver debug logging |
| `WHK_DEBUG`                             | Enable CLI debug logging      |

## CI/CD & Releases

- **CI** (`.github/workflows/ci.yml`): lint, typecheck, build-web, build-go, test-go, lint-go, build-rust, test-rust, lint-rust
- **CLI release** (`cli-release.yml`): triggered by `v*` tags, GoReleaser builds for linux/darwin/windows (amd64/arm64), cosign keyless signing, Homebrew tap publish
- **SDK publish** (`sdk-publish.yml`): triggered by `sdk-v*` tags, publishes `@webhooks-cc/sdk` to npm
- **MCP publish**: triggered by `mcp-v*` tags, publishes `@webhooks-cc/mcp` to npm
- **Security**: Dependabot, CodeQL analysis

## Key Gotchas

- Convex optional fields must be `undefined`, not `null` (except `v.null()` in validators)
- HTTP actions served from `.convex.site`, not `.convex.cloud`
- Rust receiver requires Redis — configured via `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB` in `.env.local`
- Rust receiver flush uses at-most-once delivery — batches are dropped (not retried) on network/server errors to prevent duplicates
- `generateUniqueSlug` helper uses `any` type for db parameter (Convex DB types are complex generics)
- Device auth `apiKey` field in schema is vestigial (raw keys are no longer stored, generated at claim time)
- The Rust receiver caches endpoint info for 300s — mock response changes propagate via cache invalidation (Convex mutations schedule it automatically) or cache warmer refresh
- Free user billing periods are lazy: `periodEnd` is unset until first request triggers `checkAndStartPeriod`

## Licensing

Split license model:

- **AGPL-3.0**: `apps/web`, `apps/receiver-rs`, `convex/`
- **MIT**: `apps/cli`, `packages/sdk`, `packages/mcp`, `apps/go-shared`
