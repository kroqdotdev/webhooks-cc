# AGENTS.md

Guidance for coding agents working in this repository. Claude Code loads this file through `CLAUDE.md`; other agents read it directly.

Keep this file to what an agent cannot learn by reading the code: commands, environment facts, conventions, decisions and the reasons behind them, and boundaries. Do not add lists of routes, tables, tools, files, or env vars. They drift, and the code is the source of truth.

## What this is

webhooks.cc is a production webhook inspection and testing service. Users capture incoming webhooks, inspect requests, configure mock responses, verify provider signatures, and forward requests to localhost with the CLI. A TypeScript SDK (`@webhooks-cc/sdk`) and an MCP server (`@webhooks-cc/mcp`) give programmatic and AI-agent access. Teams share endpoints under a pooled, per-seat subscription.

Production: `https://webhooks.cc` (app) and `https://go.webhooks.cc` (webhook receiver). The repository is public.

## Layout

| Path | What lives there |
| --- | --- |
| `apps/web/` | Next.js 16 App Router, React 19, Tailwind v4, shadcn/ui. Dashboard, marketing and SEO pages, API routes under `app/api/`, env validation in `lib/env.ts`. |
| `content/docs/` | MDX source for `/docs/*`, rendered by the catch-all route in `apps/web/app/docs/`. |
| `apps/receiver-rs/` | Rust (Axum, Tokio, sqlx) webhook receiver. Captures at `/w/{slug}`. Env vars are read in `src/config.rs`. |
| `apps/cli-rs/` | Rust CLI `whk` (Clap, Ratatui). Subcommands live in `src/cli/`. |
| `packages/sdk/` | `@webhooks-cc/sdk`, published to npm. Also the canonical provider catalog (`TEMPLATE_PROVIDERS`, `VERIFY_PROVIDERS`). |
| `packages/mcp/` | `@webhooks-cc/mcp`, stdio MCP server. Tools in `src/tools.ts`; the test suite pins the tool and provider counts. |
| `supabase/migrations/` | Numbered SQL files: schema, functions, RLS policies, pg_cron jobs. Applied by hand with psql. |
| `infra/` | Cloudflare Worker notify proxy, GoTrue email-auth config notes, AppSignal collector systemd unit. |
| `docs/`, `branch-docs/` | Local planning docs. Both are gitignored. |

## Commands

```bash
pnpm install
make dev                  # mprocs: web + receiver side by side
pnpm dev:web              # web only
make dev-receiver         # Rust receiver, sources .env.local
make dev-cli ARGS="..."   # run the CLI from source

pnpm typecheck && pnpm lint && pnpm build
pnpm test                               # SDK + MCP + web unit tests
cd apps/web && pnpm test:integration    # needs the local Supabase stack; some suites need the receiver running
cd apps/receiver-rs && cargo test && cargo clippy -- -D warnings
cd apps/cli-rs && cargo test
pnpm test:full                          # everything, including integration and Playwright e2e
```

### Running in production

On the app host, the web app and receiver are user-level systemd units named `webhooks-web` and `webhooks-receiver`. A build alone changes nothing: the old binary keeps running until the unit restarts. Use the deploy targets, which build and restart together.

```bash
make deploy-receiver | make deploy-web | make deploy-all
make prod-status | make prod-restart
make prod                 # start services if needed and open the mprocs log viewer
journalctl --user -u webhooks-receiver -f
```

The AppSignal collector (`appsignal-collector`, port 8099) is a system unit and needs sudo; `make deploy-collector` restarts it.

### Database changes

Migrations are plain SQL files in `supabase/migrations/`, numbered sequentially. There is no migration runner. Apply each file with `psql "$SUPABASE_DB_URL" -f <file>` against dev first, then against prod as part of the deploy. Two rules that are easy to miss:

- After adding or changing an RPC, column, or policy, run `NOTIFY pgrst, 'reload schema';`. PostgREST caches the schema, and new RPCs return 404 until it reloads.
- Run migrations with plain psql in autocommit mode, with `--set=ON_ERROR_STOP=1` and a short `lock_timeout` on prod. Some migrations use `CREATE INDEX CONCURRENTLY` and `NOT VALID` constraints that fail inside a transaction.

## How it fits together

Web (3000), receiver (3001), collector (8099), a self-hosted Supabase instance (Postgres, Auth, Realtime), a Cloudflare Worker for outbound notifications, and optional Redis for distributed rate limiting.

Capture path: a sender POSTs to `go.webhooks.cc/w/{slug}/...`. The receiver validates the slug, strips proxy headers, and calls the `capture_webhook()` stored procedure once. That single call looks up the endpoint, checks expiry, decrements quota atomically, inserts the request, bumps counters, and picks the billing pool. The receiver answers with the configured mock response or a plain 200. Dashboards update over Supabase Realtime; the CLI streams over SSE from `/api/stream/{slug}`.

Decisions worth knowing, with the reasons:

- **The receiver talks to Postgres directly** through the Supabase session pooler (`DATABASE_URL`), not through the web app. One fewer hop on the hot path, and the stored procedure keeps quota and counters atomic.
- **DB failures are classified.** Transient errors (pool timeout, connection loss, SQLSTATE classes 08/40/53/57/58) return 503 with `Retry-After: 5` so senders retry; at-least-once delivery beats silent loss. Permanent errors fail open with 200 and are logged and counted in `webhooks_capture_failed_total{kind}`. NUL bytes in bodies and paths are sanitised (raw bytes kept in `body_raw`) instead of failing the insert.
- **RLS is deny-by-default for client roles.** Anonymous users cannot read endpoints, requests, or device codes; they may only insert ephemeral endpoints with a bounded expiry and read published blog posts. Guest dashboard reads go through server routes using the service role. Client roles have no write access to `users` and no EXECUTE on `public` functions unless a migration grants it (migration 00037 revoked them and reset the default privileges). Team members can read shared endpoints through `can_view_team_endpoint()`, which is what lets Realtime deliver to them.
- **Sensitive routes want a session, not an API key.** Account deletion and billing mutations reject API keys with 403.
- **Teams are billed per team.** A Polar seat subscription on the `teams` row buys the member cap and a pooled quota of seats x 100,000 requests per 30 days. `users.plan` stays free or pro and does not gate team access. `capture_webhook()` bills an endpoint shared with an active team against that team and stamps `requests.team_id`; team-billed requests keep 31-day retention regardless of the owner's plan. Each team gets its own Polar customer of type team: Polar allows one customer per email per organisation, so the owner's personal customer is never reused. Never log a raw Polar SDK error, it embeds the bearer token; use `loggablePolarError()` from `lib/polar.ts`.
- **Free periods are lazy.** `period_end` is unset until the first capture triggers `start_free_period()`.
- **Guest endpoint creation is bot-gated.** `POST /api/go/endpoint` returns 403 for crawler or missing user agents, and the landing page only auto-creates an endpoint after a human input signal. Browsers with `navigator.webdriver` get a manual create button, so Playwright and agents must click it and tests must send a browser user agent.
- **Site totals survive deletes.** `site_stats.total_webhooks` is `sum(endpoints.request_count) + deleted_webhooks`; an AFTER DELETE trigger on `endpoints` (migration 00038) moves the counts of deleted rows into `deleted_webhooks`. Do not add another accumulate step to any delete path.
- **Outbound notifications hide the origin IP** by going through the Cloudflare Worker when `NOTIFY_PROXY_URL` is set; otherwise the receiver delivers directly with SSRF-safe DNS pinning.
- **Email/password auth is GoTrue configuration, not app code.** SMTP, minimum password length 8, and the template URLs live in the Supabase instance's `docker-compose.override.yml`; see `infra/supabase/gotrue-email-auth.md`. Email links carry a `token_hash` to `/auth/confirm`, which verifies server-side. If GoTrue could not fetch the templates at startup it keeps serving its defaults until the auth container restarts.
- **Agent registration follows the auth.md protocol.** Unclaimed agent API keys have `api_keys.user_id = NULL` and are confined to the sandbox routes until claimed, so every consumer of an API key must tolerate a null user. `AGENT_IDJAG_PROVIDERS` stays empty in production until a real ID-JAG issuer exists.
- **Adding a webhook provider** touches the SDK catalog, the web editorial data in `apps/web/lib/webhook-provider-pages.ts`, the pinned counts in the MCP tests, and a migration that extends the `check_signing_config` CHECK constraint on `endpoints`. The constraint is the one people forget; the signature-verification integration test is what catches it.

## Environment

Env vars are validated with zod in `apps/web/lib/env.ts` and loaded in `apps/receiver-rs/src/config.rs`; read those for the current list and defaults. `.env.example` documents the required set. Secrets live only in `.env.local`, which is gitignored. Three that trip people up:

- `DATABASE_URL` (receiver) must be the Supabase session pooler URL, not the direct connection. `SUPABASE_DB_URL` is the direct connection and is used for migrations.
- `SIGNING_SECRET_KEY` (AES-256-GCM, base64, 32 bytes) is needed by both the receiver and the web app once signature verification is configured. Generate with `openssl rand -base64 32`.
- Polar, SMTP, AppSignal, and Redis are optional in development.

## Conventions

- **Branch and PR for every change.** `main` requires linear history, signed commits, and a PR; only squash or rebase merges are allowed. Commits are GPG-signed locally.
- **Reviews.** CodeRabbit, Codex, and CodeQL comment on every PR; address their findings before merging. CI runs lint, typecheck, the web build, the SDK, MCP, and web unit suites, and the Rust build, test, and clippy jobs. Web integration tests and Playwright do not run in CI, so run them locally when you touch the web app.
- **Version and changelog on every web PR.** Bump `APP_VERSION` in `apps/web/lib/changelog.ts` and `version` in `apps/web/package.json` (patch for fixes and small features, minor for significant features, major reserved for 1.0) and add a `track: "web"` entry at the top of the web section. CLI, SDK, and MCP releases bump `CLI_VERSION`, `SDK_VERSION`, or `MCP_VERSION` and add an entry on their own track when the tag is cut (`v*`, `sdk-v*`, `mcp-v*`). A unit test keeps the SDK and MCP constants in sync with the package versions.
- **Tests live next to the code they cover.** Unit tests as `*.test.ts` beside the source, web integration suites in `apps/web/tests/integration/`, Rust tests in each crate. Scratch verification scripts stay out of the repo.
- **Design system.** The UI is neobrutalist, built on the shadcn/ui primitives in `components/ui` with Space Grotesk and JetBrains Mono. Reuse those primitives rather than introducing new styling patterns.
- **Formatting.** Prettier and ESLint are enforced in CI; run `pnpm format` before committing. `apps/web/public/email-templates/` is excluded because Prettier breaks Go template actions.
- **No em dashes** anywhere: code, comments, docs, commit messages.

## Boundaries

- Production is real and serves paying users. Do not deploy, restart production services, apply migrations to production, publish packages, or change Polar or Supabase instance configuration unless the task explicitly asks for it. Production runs on separate hosts reached over ssh; the `make deploy-*` targets act on the machine they run on.
- Ask before anything that costs money or sends real email: Polar checkouts, invites to real addresses, notification tests against third-party URLs.
- Never source `.env.local` wholesale in shell scripts or paste secrets into logs, PR bodies, or commit messages. Extract single variables when needed.
- New `public` functions are service-role only. Grant client EXECUTE in a migration only when the function is meant to be called from the browser.
- Never add `revoke` or `grant` statements to `handle_new_user()`; it runs as `supabase_auth_admin` from an auth trigger.

## Licensing

Split model. AGPL-3.0: `apps/web`, `apps/receiver-rs`, `supabase/`. MIT: `apps/cli-rs`, `packages/sdk`, `packages/mcp`.
