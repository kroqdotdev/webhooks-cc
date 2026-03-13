# Phase 2: Control Plane Migration

**Goal:** move the first Convex-backed product APIs to Supabase so the CLI, SDK, and web app can start using Supabase for auth-adjacent operations without touching the receiver yet.

**Status:** complete on this branch. The control-plane slice landed, was integration-tested against the dev Supabase instance, and has already been exercised live in the dev app.

**Why this phase comes next:** Phase 1 proved Supabase Auth works. The fastest way to keep momentum is to migrate the control plane first: API key validation, device auth, endpoint CRUD, and usage reads. These are lower risk than the request ingestion path and unlock the next dashboard and CLI slices.

**Non-negotiables:**

- Final architecture removes Redis.
- Do not add new Redis-based migration work.
- Preserve current CLI and SDK API shapes.
- Keep this phase narrow. No request ingestion rewrite, billing rewrite, or broad Convex cleanup here.

## In Scope

- Create `supabase/migrations/00002_additional_functions.sql`
  - Add `check_and_increment_ephemeral(p_endpoint_id uuid)`
  - Add composite index on `users(plan, period_end)`
- Add shared server-side Supabase helpers for:
  - API key hashing and validation
  - Device code creation, authorization, polling, and claiming
  - Endpoint CRUD by user
- Replace Convex-backed Next.js routes:
  - `/api/auth/device-code`
  - `/api/auth/device-poll`
  - `/api/auth/device-claim`
  - `/api/endpoints`
  - `/api/endpoints/[slug]`
- Replace the browser-side `/cli/verify` flow so it authorizes device codes through Supabase-backed server code instead of Convex mutations.
- Add focused tests for the new Supabase-backed helpers and route behavior.

## Explicitly Out of Scope

- Receiver rewrite
- Request list/detail/search migration
- Dashboard realtime migration
- Billing migration
- Blog/feed/sitemap migration
- Convex directory removal
- Redis removal in the running receiver

## Work Order

1. **Schema support**
   - Add `00002_additional_functions.sql`
   - Verify the new SQL runs cleanly in dev Supabase

2. **Shared helpers**
   - Add a small server-side module for API key hashing, device auth, and endpoint CRUD
   - Keep helpers close to current API route shapes to avoid extra abstraction

3. **Device auth**
   - Migrate route handlers first
   - Then migrate `/cli/verify`
   - Verify CLI login still works against the same HTTP endpoints

4. **Endpoint CRUD**
   - Migrate `/api/endpoints`
   - Migrate `/api/endpoints/[slug]`
   - Preserve response shapes used by the CLI and SDK

5. **Verification**
   - Run targeted integration tests against Supabase dev
   - Run relevant web and CLI smoke tests for device auth and endpoint CRUD

## Definition of Done

- [x] Device auth no longer depends on Convex
- [x] Endpoint CRUD API routes no longer depend on Convex
- [x] `apps/web/lib/api-auth.ts` validates API keys against Supabase
- [x] Existing CLI and SDK endpoint flows keep the same external API shapes
- [x] The next phase can focus on request data and dashboard reads instead of auth/control-plane cleanup

## What Landed

- `supabase/migrations/00002_additional_functions.sql`
- Supabase-backed API key validation and shared auth helpers
- Supabase-backed device auth routes and `/cli/verify`
- Supabase-backed endpoint CRUD routes
- Supabase-backed usage route

## Verification Completed

- `pnpm exec tsc --noEmit` in `apps/web`
- `pnpm vitest run tests/integration/supabase-auth.test.ts tests/integration/supabase-control-plane.test.ts tests/integration/supabase-device-auth.test.ts`
- Live dev validation:
  - GitHub OAuth login works
  - endpoint creation works
  - request capture works
  - usage limit enforcement works

## Follow-on Work Already Landed After This Phase

The branch has already moved past the original control-plane boundary:

- request list/detail routes are Supabase-backed
- dashboard endpoint management and request views no longer rely on Convex hooks
- receiver-facing internal control-plane routes exist so the dev receiver can exercise Supabase-backed capture flows

That follow-on work has now landed too: request list/detail, usage reads in the dashboard, request search, public blog/feed/sitemap reads, blog admin writes, and billing/account management are all Supabase-backed on this branch.

## Remaining Major Phases

The remaining major phases after the web/API migration are:

- [x] request list/detail reads
- [x] request search
- [x] usage reads in the dashboard
- [x] public read-only blog/feed/sitemap queries
- [x] billing/account management

The next active gaps are realtime/SSE, the remaining account/API-key UI cleanup, cron cleanup/reset jobs, and then the receiver rewrite that finally removes Redis/ClickHouse/Convex from the hot path.
