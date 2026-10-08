# AGENTS.md

Guidance for coding agents working in this repository. Claude Code loads this file through `CLAUDE.md`; other agents read it directly.

Keep this file to what an agent cannot learn by reading the code: commands, environment facts, conventions, decisions and the reasons behind them, and boundaries. Do not add lists of routes, tables, tools, files, or env vars. They drift, and the code is the source of truth. The layout table below is the one map this file keeps: it names top-level directories and stays at that altitude.

## What this is

webhooks.cc is a production webhook inspection and testing service. Users capture incoming webhooks, inspect requests, configure mock responses, verify provider signatures, and forward requests to localhost with the CLI. A TypeScript SDK (`@webhooks-cc/sdk`) and an MCP server (`@webhooks-cc/mcp`) give programmatic and AI-agent access. Teams share endpoints under a pooled, per-seat subscription.

Production: `https://webhooks.cc` (app) and `https://go.webhooks.cc` (webhook receiver). The repository is public.

## Layout

| Path                    | What lives there                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/`             | Next.js 16 App Router, React 19, Tailwind v4, shadcn/ui. Dashboard, marketing and SEO pages, API routes under `app/api/`, env validation in `lib/env.ts`. |
| `content/docs/`         | MDX source for `/docs/*`, rendered by the catch-all route in `apps/web/app/docs/`.                                                                        |
| `apps/receiver-rs/`     | Rust (Axum, Tokio, sqlx) webhook receiver. Captures at `/w/{slug}`. Env vars are read in `src/config.rs`.                                                 |
| `apps/mx-rs/`           | Rust (Tokio) receive-only SMTP host for email capture on `mailhooks.cc`. Env vars are read in `src/config.rs`.                                            |
| `apps/cli-rs/`          | Rust CLI `whk` (Clap, Ratatui). Subcommands live in `src/cli/`.                                                                                           |
| `packages/sdk/`         | `@webhooks-cc/sdk`, published to npm. Also the canonical provider catalog (`TEMPLATE_PROVIDERS`, `VERIFY_PROVIDERS`).                                     |
| `packages/mcp/`         | `@webhooks-cc/mcp`, stdio MCP server. Tools in `src/tools.ts`; the test suite pins the tool and provider counts.                                          |
| `supabase/migrations/`  | Numbered SQL files: schema, functions, RLS policies, pg_cron jobs. Applied by hand with psql.                                                             |
| `infra/`                | Cloudflare Worker notify proxy, GoTrue email-auth config notes.                                                                                           |
| `docs/`, `branch-docs/` | Local planning docs. Both are gitignored.                                                                                                                 |

## Commands

```bash
pnpm install
make dev                  # mprocs: web + receiver side by side
pnpm dev:web              # web only
make dev-receiver         # Rust receiver, sources .env.local
make dev-cli ARGS="..."   # run the CLI from source

pnpm typecheck && pnpm lint && pnpm build
pnpm test                               # SDK + MCP + web unit tests
cd apps/web && pnpm test:integration    # needs the local Supabase stack; some suites need the receiver running (make dev-receiver, which also opens its mail listener)
cd apps/receiver-rs && cargo test && cargo clippy -- -D warnings
cd apps/mx-rs && cargo test && cargo clippy --all-targets -- -D warnings
cd apps/cli-rs && cargo test
pnpm test:full                          # everything, including integration and Playwright e2e
```

### Running in production

Production runs as containers on a single host: the web app and receiver images built from this repository (`apps/web/Dockerfile`, `apps/receiver-rs/Dockerfile`), Caddy, Redis, the AppSignal collector, and a self-hosted Supabase project, all under Docker Compose. Images are built in CI and shipped to the host; the host never builds. The deploy workflow, compose files, and host configuration live in a separate private operations repository, not here.

A deploy builds the images for a given ref of this repository, loads them on the host, and recreates the web and receiver containers (and, where configured, the SMTP listener on the MX host). `NEXT_PUBLIC_*` values are build arguments, so changing one means a new build, not a restart. The CI job "Build Docker Images" checks on every PR that the images still build.

### Database changes

Migrations are plain SQL files in `supabase/migrations/`, numbered sequentially. There is no migration runner. Apply each file against dev first, then against prod before deploying the release that needs it (the production database is only reachable from its host):

```bash
PGOPTIONS="-c lock_timeout=5s" psql "$SUPABASE_DB_URL" --set=ON_ERROR_STOP=1 -f supabase/migrations/<file>.sql
psql "$SUPABASE_DB_URL" -c "NOTIFY pgrst, 'reload schema';"
```

Two rules that are easy to miss:

- After adding or changing an RPC, column, or policy, run the `NOTIFY` above. PostgREST caches the schema, and new RPCs return 404 until it reloads.
- Keep the psql invocation as shown: plain autocommit mode, because some migrations use `CREATE INDEX CONCURRENTLY` and `NOT VALID` constraints that fail inside a transaction; `ON_ERROR_STOP` so a failed statement halts the run instead of leaving a half-applied file; a short `lock_timeout` so a DDL lock wait cannot stall production traffic.

## How it fits together

Web (3000), receiver (3001, plus a private mail listener on 3002), collector (8099), the SMTP listener for `mailhooks.cc` on its own box (25), a self-hosted Supabase instance (Postgres, Auth, Realtime), a Cloudflare Worker for outbound notifications, and optional Redis for distributed rate limiting.

Capture path: a sender POSTs to `go.webhooks.cc/w/{slug}/...`. The receiver validates the slug, strips proxy headers, and calls the `capture_webhook()` stored procedure once. That single call looks up the endpoint, checks expiry, decrements quota atomically, inserts the request, bumps counters, and picks the billing pool. The receiver answers with the configured mock response or a plain 200. Dashboards update over Supabase Realtime; the CLI streams over SSE from `/api/stream/{slug}`.

Decisions worth knowing, with the reasons:

- **The receiver talks to Postgres directly** (`DATABASE_URL`), not through the web app. One fewer hop on the hot path, and the stored procedure keeps quota and counters atomic. In production it connects to Postgres on the same Docker network rather than through Supavisor: on one host the pooler only costs CPU, and a load test sustained about twice the throughput without it.
- **DB failures are classified.** Transient errors (pool timeout, connection loss, SQLSTATE classes 08/40/53/57/58) return 503 with `Retry-After: 5` so senders retry; at-least-once delivery beats silent loss. Permanent errors fail open with 200 and are logged and counted in `webhooks_capture_failed_total{kind}`. NUL bytes in bodies and paths are sanitised (raw bytes kept in `body_raw`) instead of failing the insert.
- **RLS is deny-by-default for client roles.** Anonymous users cannot read endpoints, requests, or device codes, and may only read published blog posts. Guest dashboard reads and guest endpoint creation go through server routes using the service role. Client roles have no write access to `users`, `endpoints`, or `api_keys` (migrations 00037 and 00045; every write goes through a server route that validates, rate-limits, and audits it) and no EXECUTE on `public` functions unless a migration grants it (00037 revoked them and reset the default privileges). Team members can read shared endpoints through `can_view_team_endpoint()`, which also lets them join the endpoint's Realtime topic.
- **Live updates are Realtime Broadcast signals, not `postgres_changes`.** Triggers send `realtime.send()` signals carrying only ids on private topics (`endpoint:<id>` for request and deletion events, `user:<id>` for plan, billing and quota-state changes), and clients re-read through the authenticated routes. `postgres_changes` evaluates every change against every subscriber's RLS inside Postgres, which capped live updates far below capture throughput; a broadcast topic is authorized once per join by the `realtime.messages` policy (`can_join_realtime_topic()`). Keep `requests`, `endpoints` and `users` out of the `supabase_realtime` publication, and do not signal per capture on the user topic. The self-hosted Realtime tenant has its own rate limits (`max_events_per_second` and friends in `_realtime.tenants`) that drop messages above them.
- **Sensitive routes want a session, not an API key.** Account deletion and billing mutations reject API keys with 403.
- **Teams are billed per team.** A Polar seat subscription on the `teams` row buys the member cap and a pooled quota of seats x 100,000 requests per 30 days. `users.plan` stays free or pro and does not gate team access. `capture_webhook()` bills an endpoint shared with an active team against that team and stamps `requests.team_id`; team-billed requests keep 31-day retention regardless of the owner's plan. Each team gets its own Polar customer of type team: Polar allows one customer per email per organisation, so the owner's personal customer is never reused. Seat increases are billed at once (Polar `invoice`); seat reductions take effect at the next renewal (`next_period`), mirrored in `teams.pending_seats`, which also caps members until then. Never log a raw Polar SDK error: its message embeds the response body, which can echo customer emails; use `loggablePolarError()` from `lib/polar.ts`. The SDK is imported from a versioned entry point (`@polar-sh/sdk/2026-10`) and hands back Polar's snake_case JSON unchanged, timestamps as ISO strings. Webhook payloads follow the API version set on each webhook endpoint in the Polar dashboard, not the SDK's, so move the endpoints along when the SDK version moves.
- **The visual-style A/B split is a local coin flip, PostHog only analyses it.** posthog-js resolves feature flags after first paint, so a flag-driven style would re-skin the page in front of the visitor. `appearanceBootstrapScript()` in `apps/web/lib/ui-style.ts` assigns the variant before paint and the app reports it to PostHog as `$feature/ui-style` plus one `$feature_flag_called` exposure per session, which is what the Experiments UI reads. PostHog names experiment variants `control` and `test`, so classic and clean are mapped onto those keys and the readable name rides along as `ui_style_assigned`. Traffic lives in `NEXT_PUBLIC_UI_STYLE_SPLIT` (0 disables). It is inlined at build time on purpose: most routes are prerendered, and a request-time value would leave them serving a stale split while dynamic routes used the new one. Changing the split means a rebuild and restart. Browsers with any trace of an earlier visit keep classic and stay out of the experiment, and a visitor's own pick is never overwritten.
- **Free periods are lazy.** `period_end` is unset until the first capture triggers `start_free_period()`.
- **No trigram indexes on `requests`.** Search is substring `ILIKE` over path, body and headers without an index (migration 00044 dropped them): the indexes made every capture write about 8x the WAL and cost about a third of capture throughput, for a feature used rarely. Slug-scoped searches read only that endpoint's rows through `requests_endpoint_time`. Do not add a GIN index on `body` or `headers` without measuring capture throughput.
- **Email is an ordinary request.** Email capture lands mail for `{slug}@mailhooks.cc` as a request with `kind = 'email'`, through the same `capture_webhook()` call, quota, billing period and counters as HTTP. The SMTP host (`apps/mx-rs`) runs on its own box, so a public MX record never exposes the production IP; it refuses unknown, guest, over-quota and oversize mail before accepting it and calls the receiver's private, HMAC-signed mail listener, which must only ever be reachable on the private network, never through Caddy. It passes the raw message on byte for byte and keeps the hash of every message whose outcome the sender may not have learned (a 4xx, a lost reply, a crash mid-delivery), so the receiver can tell a sender's retry apart from a deliberate re-send. Endpoints without an owner get no email, because guest captures are readable by anyone who knows the slug. A sender's retry is matched in the database by the message hash, and only deliveries the MX host marks as retries are checked, so a message sent again on purpose is captured again. `check_email_recipient()` mirrors the billing selection in `capture_webhook()`; change them together. The capture domain never sends mail. The dashboard renders email HTML only inside a sandboxed `srcdoc` iframe (no `allow-scripts`) carrying its own CSP (`lib/email-preview.ts`); a `srcdoc` document also inherits the page's CSP, which is why dashboard pages allow `img-src https:` (`lib/csp-img-src.ts`) so "Load images" works. Never render email HTML outside that frame.
- **Guest endpoint creation is bot-gated.** `POST /api/go/endpoint` returns 403 for crawler or missing user agents, and the landing page only auto-creates an endpoint after a human input signal. Browsers with `navigator.webdriver` get a manual create button, so Playwright and agents must click it and tests must send a browser user agent.
- **Site totals survive deletes.** `site_stats.total_webhooks` is `sum(endpoints.request_count) + deleted_webhooks`; an AFTER DELETE trigger on `endpoints` (migration 00038) moves the counts of deleted rows into `deleted_webhooks`. Do not add another accumulate step to any delete path.
- **State changes leave an audit trail; webhook traffic leaves only counts.** Routes that change account, team, billing, API key, or endpoint state call `auditUserAction()` from `lib/audit.ts`, and the Polar webhook calls `auditPolarEvent()`; both write `audit_events` (kept a year) and print one `[audit]` line, and never throw. Add the call when you add such a route. Individual webhooks are never logged: `capture_webhook()` upserts per-endpoint daily counts into `endpoint_daily_stats`, which outlives request retention and endpoint deletion.
- **Outbound notifications hide the origin IP** by going through the Cloudflare Worker when `NOTIFY_PROXY_URL` is set; otherwise the receiver delivers directly with SSRF-safe DNS pinning.
- **Email/password auth is GoTrue configuration, not app code.** SMTP, minimum password length 8, and the template URLs live in the Supabase instance's `docker-compose.override.yml`; see `infra/supabase/gotrue-email-auth.md`. Email links carry a `token_hash` to `/auth/confirm`, which verifies server-side. If GoTrue could not fetch the templates at startup it keeps serving its defaults until the auth container restarts.
- **Agent registration follows the auth.md protocol.** Unclaimed agent API keys have `api_keys.user_id = NULL` and are confined to the sandbox routes until claimed, so every consumer of an API key must tolerate a null user. `AGENT_IDJAG_PROVIDERS` stays empty in production until a real ID-JAG issuer exists.
- **Adding a webhook provider** touches the SDK catalog, the web editorial data in `apps/web/lib/webhook-provider-pages.ts`, the pinned counts in the MCP tests, and a migration that extends the `check_signing_config` CHECK constraint on `endpoints`. The constraint is the one people forget; the signature-verification integration test is what catches it.

## Environment

Env vars are validated with zod in `apps/web/lib/env.ts` and loaded in `apps/receiver-rs/src/config.rs` and `apps/mx-rs/src/config.rs`; read those for the current list and defaults. `.env.example` documents the required set. Secrets live only in `.env.local`, which is gitignored. Three that trip people up:

- `DATABASE_URL` (receiver) is the session pooler in development and a direct same-host connection in production. Keep `PG_POOL_MAX` small (about 20) whenever it bypasses a pooler: every capture updates the same user and endpoint rows, and hundreds of direct connections only queue on those row locks. For the same reason the receiver caps concurrent captures per billing account (`CAPTURE_MAX_INFLIGHT_PER_ACCOUNT`, default 4, keyed by the `billing_key` that `capture_webhook()` returns): without it one flooded account fills the pool and every other account waits. `SUPABASE_DB_URL` is the direct connection used for migrations.
- `SIGNING_SECRET_KEY` (AES-256-GCM, base64, 32 bytes) is needed by both the receiver and the web app once signature verification is configured. Generate with `openssl rand -base64 32`.
- Polar, SMTP, AppSignal, and Redis are optional in development.

## Conventions

- **Branch and PR for every change.** `main` requires linear history, signed commits, and a PR; only squash or rebase merges are allowed. Commits are GPG-signed locally.
- **Reviews.** CodeRabbit, Codex, and CodeQL comment on every PR; address their findings before merging. CI runs lint, typecheck, the web build, the SDK, MCP, and web unit suites, and the Rust build, test, and clippy jobs. Web integration tests and Playwright do not run in CI, so run them locally when you touch the web app.
- **Version and changelog on every web PR.** Bump `APP_VERSION` in `apps/web/lib/changelog.ts` and `version` in `apps/web/package.json` (patch for fixes and small features, minor for significant features, major reserved for 1.0) and add a `track: "web"` entry at the top of the web section. CLI, SDK, and MCP releases bump `CLI_VERSION`, `SDK_VERSION`, or `MCP_VERSION` and add an entry on their own track when the tag is cut (`v*`, `sdk-v*`, `mcp-v*`). A unit test keeps the SDK and MCP constants in sync with the package versions.
- **Tests live next to the code they cover.** Unit tests as `*.test.ts` beside the source, web integration suites in `apps/web/tests/integration/`, Rust tests in each crate. Scratch verification scripts stay out of the repo.
- **Design system.** The UI ships in two styles that each user picks next to the light and dark switch: classic (neobrutalist, Space Grotesk) and clean (close to stock shadcn/ui, Geist). Both share one component tree; `data-style` on `<html>` swaps the tokens, independently of light and dark mode. Write classes with the style-aware vocabulary documented at the top of `apps/web/app/globals.css` (`border-strong`, `border-line`, `shadow-raised`, `caps`, the `ui-*` classes) instead of raw `border-2 border-foreground` or `uppercase tracking-wide`; `lib/ui-style-contract.test.ts` fails on the classic-only utilities. Check new UI in both styles, and reuse the shadcn/ui primitives in `components/ui` rather than introducing new styling patterns.
- **Formatting.** Prettier and ESLint are enforced in CI; run `pnpm format` before committing. `apps/web/public/email-templates/` is excluded because Prettier breaks Go template actions.
- **No em dashes** anywhere: code, comments, docs, commit messages.

## Boundaries

- Production is real and serves paying users. Do not deploy, restart production services, apply migrations to production, publish packages, or change Polar or Supabase instance configuration unless the task explicitly asks for it. Production runs on a separate host and deploys through the private operations repository; do not build or deploy from a development machine.
- Ask before anything that costs money or sends real email: Polar checkouts, invites to real addresses, notification tests against third-party URLs.
- Never source `.env.local` wholesale in shell scripts or paste secrets into logs, PR bodies, or commit messages. Extract single variables when needed.
- New `public` functions are service-role only. Grant client EXECUTE in a migration only when the function is meant to be called from the browser.
- Never add `revoke` or `grant` statements to `handle_new_user()`; it runs as `supabase_auth_admin` from an auth trigger.

## Licensing

Split model. AGPL-3.0: `apps/web`, `apps/receiver-rs`, `apps/mx-rs`, `supabase/`. MIT: `apps/cli-rs`, `packages/sdk`, `packages/mcp`.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
