# AGENT.md

Operating guide for coding agents working in `webhooks-cc`.

## Mission

Ship safe, minimal, verified changes in a mixed TypeScript/Rust/Go monorepo that powers webhook capture, inspection, CLI tunneling, and a public SDK.

## Stack At A Glance

- Monorepo tooling: `pnpm` workspaces + `turbo`
- Web app: Next.js 16, React 19, Tailwind v4 (`apps/web`)
- Backend/data/auth: Convex (`convex`)
- Receiver: Rust Axum service for `/w/{slug}` capture (`apps/receiver-rs`)
- CLI: Go Cobra (`apps/cli`)
- Shared Go types: `apps/go-shared`
- SDK: TypeScript package `@webhooks-cc/sdk` (`packages/sdk`)

## Repo Map

- `apps/web`: app routes, API routes, UI components, auth/session UI, SSE bridge for CLI stream
- `convex`: schema, queries/mutations/actions, HTTP actions, cron jobs, billing, device auth
- `apps/receiver-rs`: high-throughput webhook ingress (Axum + Tokio + Redis), quota via Lua scripts, batching, circuit breaker
- `apps/cli`: end-user CLI (`auth`, `create/list/delete`, `listen`, `tunnel`, `replay`, `update`)
- `packages/sdk`: public API client + helpers + tests
- `.github/workflows`: CI, CLI release, SDK publish
- `docs`: internal docs (currently gitignored by root `.gitignore`)

## Local Prerequisites

- Node.js `>=20` (root `package.json`)
- `pnpm@10.28.2`
- Go `1.25.x` (`apps/cli/go.mod`)
- Rust stable (`apps/receiver-rs/`)
- Redis on localhost:6380 (for receiver)

## Environment

Shared env lives in `.env.local` (see `.env.example` and validators):

- Public/client-safe vars: `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_WEBHOOK_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SENTRY_DSN` (optional)
- Server-only vars: `CONVEX_SITE_URL`, `CAPTURE_SHARED_SECRET`, `SENTRY_DSN` (optional)
- Billing vars: `POLAR_*`
- Convex runtime config vars: `FREE_REQUEST_LIMIT`, `PRO_REQUEST_LIMIT`, `EPHEMERAL_TTL_MS`, `BILLING_PERIOD_MS`

Important: Convex config vars in `convex/config.ts` are read at module load/deploy time. After changing them, redeploy/push functions.

## Core Dev Commands

- Install: `pnpm install`
- Web dev: `pnpm dev:web`
- Convex dev: `pnpm dev:convex`
- Receiver dev: `make dev-receiver`
- CLI dev: `make dev-cli ARGS="auth status"`
- Full build: `make build`
- TS build only: `pnpm build`
- Typecheck: `pnpm typecheck`
- Lint TS: `pnpm lint`
- Format: `pnpm format`
- Format check only: `pnpm format:check`

If using the systemd receiver process, rebuilding is not enough. Restart service after `make build-receiver` so new binary is actually used.

## Test Matrix

- Full suite: `make test`
- Convex tests: `pnpm test:convex`
- Receiver tests: `cd apps/receiver-rs && cargo test`
- CLI tests: `cd apps/cli && go test ./...`
- SDK tests: `pnpm --filter @webhooks-cc/sdk test`

CI also runs Go race tests and golangci-lint on `apps/cli`, and clippy on `apps/receiver-rs`.

## Architecture Notes

Webhook path:

1. External webhook -> Rust receiver `POST /w/{slug}/*`
2. Receiver validates slug/body/headers, checks quota via Redis Lua script, buffers request in Redis list
3. Background flush workers (4x) drain Redis buffers to Convex HTTP actions (`/capture-batch`)
4. Convex stores request rows, schedules usage increments, serves dashboard/CLI reads
5. Web dashboard reads from Convex; CLI streams via web SSE endpoint (`/api/stream/[slug]`)

Key operational behaviors:

- Receiver endpoint cache in Redis with 300s TTL, proactively warmed
- Quota enforced atomically via Redis Lua scripts (no locks)
- Request buffering in Redis lists, atomic batch-take via Lua script
- Redis-backed circuit breaker protects outbound Convex calls
- Free-plan period starts lazily on first request (`check-period`)

## Where To Edit

- Endpoint CRUD/auth constraints: `convex/endpoints.ts`
- Request capture/quota/cleanup: `convex/requests.ts`
- Billing + Polar webhooks: `convex/billing.ts`
- API key lifecycle: `convex/apiKeys.ts`
- Device auth flow: `convex/deviceAuth.ts` and `apps/web/app/api/auth/device-*`
- Convex HTTP surface for receiver/CLI: `convex/http.ts`
- Receiver ingest/runtime behavior: `apps/receiver-rs/src/`
- CLI streaming/tunneling/auth/update: `apps/cli/internal/*`, command wiring in `apps/cli/cmd/whk/main.go`
- Dashboard/API UX: `apps/web/app/*`, `apps/web/components/*`, `apps/web/lib/*`
- SDK contract/helpers: `packages/sdk/src/*`

## Non-Obvious Gotchas

- Convex HTTP actions use `.site` URL, not `.cloud`
- In Convex data models, optional fields should usually be `undefined` rather than `null` unless schema explicitly allows `v.null()`
- Receiver changes to mock/endpoint settings may appear delayed if cache invalidation has not propagated yet
- Free plan quota periods are rolling and initialized lazily
- Receiver requires Redis running on localhost:6380
- Web SSE route is long-lived polling-to-SSE bridge with a max connection duration

## Security-Sensitive Areas

- Shared secret validation between services (`CAPTURE_SHARED_SECRET`)
- Polar webhook signature handling
- API key hashing and validation logic
- Header/body sanitization for mock responses and forwarding
- CSV export sanitization (formula injection defense)

Treat these paths as high-regression risk; prefer focused tests when touching them.

## Change Workflow For Agents

1. Identify exact subsystem(s) and data flow touched.
2. Make minimal edits in the owning module.
3. Run narrow tests first, then broader suite if cross-cutting.
4. Verify lint/typecheck for TS changes and `go test` for Go changes.
5. Summarize behavioral impact and residual risk clearly.

## Licensing Boundaries

- AGPL-3.0: `apps/web`, `apps/receiver-rs`, `convex`
- MIT: `apps/cli`, `apps/go-shared`, `packages/sdk`
