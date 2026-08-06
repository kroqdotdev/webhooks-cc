# Teams Seat-Based Billing — Plan A (Billing Core + Pooled Quota) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teams require a Polar seat-based subscription; purchased seats set the member cap and a pooled request quota (seats × 100k/30d) tracked on the `teams` row.

**Architecture:** A new migration adds billing columns to `teams`, `polar_seat_id` to `team_members`, and `team_id` to `requests`; `capture_webhook` bills team-shared endpoints against the team pool. A new `lib/supabase/team-billing.ts` owns all Polar calls (per-team customer, checkout, seats, webhook apply); the existing `/api/polar-webhook` route branches team events to it. All `requirePro` gating is replaced by "team subscription active".

**Tech Stack:** Next.js 16 (App Router), Supabase (self-hosted Postgres via service-role admin client), Polar TypeScript SDK, vitest integration tests against the dev Supabase instance.

**Spec:** `docs/superpowers/specs/2026-08-05-teams-seat-billing-design.md` (sections 3–6, 9–12). Plan B (email invites) and Plan C (email/password auth) are separate documents.

## Global Constraints

- Branch: `feat/teams-seat-billing` (already created; spec committed).
- `users.plan` stays exactly `'free' | 'pro'`. Team plan state lives only on `teams`.
- Team is ACTIVE iff `teams.subscription_status IS NOT NULL`. Never invent another activeness rule.
- Pool limit constant: `seats × 100_000` per 30-day period. Constant name in TS: `TEAM_SEAT_REQUEST_LIMIT = 100_000`.
- `capture_webhook`'s signature and result statuses must NOT change (Rust receiver contract). `cd apps/receiver-rs && cargo test` must pass untouched.
- All SQL functions: `security definer set search_path = ''`, `revoke all ... from public, anon, authenticated; grant execute ... to service_role`.
- Migrations: create `supabase/migrations/00033_team_billing.sql`; apply to dev with `/opt/homebrew/opt/libpq/bin/psql "$SUPABASE_DB_URL" -f supabase/migrations/00033_team_billing.sql`. Dev Supabase runs at `/opt/lohsefar-dev-supabase` (start colima first if down: `colima start`). Load env: `set -a; source .env.local; set +a` from repo root.
- Integration tests: `cd apps/web && npx vitest run tests/integration/<file>` (requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in env, loaded from `.env.local`).
- Display price copy: **$12/seat/month** — exact string "$12/seat/mo" in UI.
- Env var for the Polar product: `POLAR_TEAMS_PRODUCT_ID`.
- Commit after every task (conventional commits, no Claude attribution).

---

### Task 1: Bump @polar-sh/sdk and add POLAR_TEAMS_PRODUCT_ID plumbing

The installed SDK (^0.48.1) predates the seats API. Upgrade it, then verify the seat surface exists and pin down the exact call shapes the rest of this plan assumes.

**Files:**
- Modify: `apps/web/package.json` (dependency `@polar-sh/sdk`)
- Modify: `package.json` (root; also lists `@polar-sh/sdk` — keep versions identical)
- Modify: `apps/web/lib/polar.ts`
- Modify: `apps/web/lib/env.ts:37` area (server env schema)
- Modify: `.env.example` (POLAR block, lines 21–25 area)

**Interfaces:**
- Produces: `getPolarTeamsCheckoutConfig(): { appUrl: string; teamsProductId: string }` from `@/lib/polar`. Later tasks call `polar.customerSeats.assign(...)`, `polar.customerSeats.revoke(...)`, `polar.customerSeats.list(...)`, `polar.subscriptions.update({ id, subscriptionUpdate: { seats } })`, `polar.subscriptions.revoke({ id })`, and `polar.checkouts.create({ products, seats, customerId, successUrl })`.

- [ ] **Step 1: Upgrade the SDK in both package.json files**

```bash
pnpm --filter web add @polar-sh/sdk@latest
pnpm add -w @polar-sh/sdk@latest
pnpm install
```

- [ ] **Step 2: Verify the seats API surface against the installed types**

Open `node_modules/@polar-sh/sdk/` types (or use `npx tsc --noEmit` on a scratch file) and confirm the exact names for: `customerSeats.assign` (params: subscription id, email, immediate-claim flag, metadata), `customerSeats.revoke`, `customerSeats.list`, the `seats` parameter on `checkouts.create` and on `subscriptions.update`'s update payload, and `subscriptions.revoke`. **If any name/casing differs from what later tasks use, fix the later call sites to match the SDK — the SDK is the source of truth.** Record the verified shapes in the task commit message body.

- [ ] **Step 3: Add teams checkout config to `apps/web/lib/polar.ts`**

Append below `getPolarCheckoutConfig` (same style):

```typescript
export function getPolarTeamsCheckoutConfig() {
  return {
    appUrl: publicEnv().NEXT_PUBLIC_APP_URL,
    teamsProductId: requireEnv("POLAR_TEAMS_PRODUCT_ID"),
  };
}
```

- [ ] **Step 4: Add `POLAR_TEAMS_PRODUCT_ID` to env validation and example**

In `apps/web/lib/env.ts`, next to the existing `RESEND_API_KEY: z.string().optional(),` line in the server schema, add:

```typescript
    POLAR_TEAMS_PRODUCT_ID: z.string().optional(),
```

In `.env.example`, under the existing POLAR vars, add:

```bash
# Seat-based Teams product (Polar dashboard -> product with "Seat-based" pricing)
# POLAR_TEAMS_PRODUCT_ID=
```

- [ ] **Step 5: Verify build + existing tests still pass**

```bash
pnpm typecheck && pnpm --filter web build
cd apps/web && npx vitest run tests/integration/supabase-billing.test.ts
```
Expected: PASS (SDK upgrade must not break the existing personal-Pro billing paths; `unwrapPolarResult` in `lib/polar.ts` already tolerates both result shapes).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore(billing): bump @polar-sh/sdk for seats API, add POLAR_TEAMS_PRODUCT_ID"
```

---

### Task 2: Migration 00033 part 1 — schema columns + TS row types

**Files:**
- Create: `supabase/migrations/00033_team_billing.sql` (schema section only; procedures appended in Tasks 3–4)
- Modify: `apps/web/lib/supabase/database.ts` (hand-maintained row types: `teams`, `team_members`, `requests`)

**Interfaces:**
- Produces: columns `teams.polar_customer_id/polar_subscription_id/subscription_status/seats/requests_used/request_limit/period_start/period_end/cancel_at_period_end`, `team_members.polar_seat_id`, `requests.team_id` — used by every later task.

- [ ] **Step 1: Write the schema section of the migration**

```sql
-- ============================================================================
-- Migration 00033: Team seat-based billing (Polar)
-- Part 1: schema. Teams get their own subscription + pooled quota state.
-- ============================================================================

alter table public.teams
  add column if not exists polar_customer_id     text,
  add column if not exists polar_subscription_id text,
  add column if not exists subscription_status   text
    check (subscription_status in ('active', 'canceled', 'past_due')),
  add column if not exists seats                 integer not null default 0,
  add column if not exists requests_used         bigint  not null default 0,
  add column if not exists request_limit         bigint  not null default 0,
  add column if not exists period_start          timestamptz,
  add column if not exists period_end            timestamptz,
  add column if not exists cancel_at_period_end  boolean not null default false;

create unique index if not exists teams_polar_customer
  on public.teams(polar_customer_id) where polar_customer_id is not null;
create unique index if not exists teams_polar_subscription
  on public.teams(polar_subscription_id) where polar_subscription_id is not null;
create index if not exists teams_period_end
  on public.teams(period_end) where subscription_status is not null;

alter table public.team_members
  add column if not exists polar_seat_id text;

alter table public.requests
  add column if not exists team_id uuid references public.teams(id) on delete set null;

create index if not exists requests_team
  on public.requests(team_id) where team_id is not null;
```

- [ ] **Step 2: Apply to dev**

```bash
set -a; source .env.local; set +a
/opt/homebrew/opt/libpq/bin/psql "$SUPABASE_DB_URL" -f supabase/migrations/00033_team_billing.sql
```
Expected: `ALTER TABLE` / `CREATE INDEX` output, no errors. (If connection fails: `colima start`, then retry.)

- [ ] **Step 3: Extend the hand-maintained row types in `database.ts`**

Find the `teams` table entry and add to its `Row` (and mirror optional variants in `Insert`/`Update`, following exactly how the `users` table entry declares its polar fields):

```typescript
          polar_customer_id: string | null;
          polar_subscription_id: string | null;
          subscription_status: "active" | "canceled" | "past_due" | null;
          seats: number;
          requests_used: number;
          request_limit: number;
          period_start: string | null;
          period_end: string | null;
          cancel_at_period_end: boolean;
```

To `team_members` Row/Insert/Update add `polar_seat_id: string | null;`. To `requests` Row/Insert/Update add `team_id: string | null;`.

- [ ] **Step 4: Typecheck, then commit**

```bash
pnpm typecheck
git add supabase/migrations/00033_team_billing.sql apps/web/lib/supabase/database.ts
git commit -m "feat(db): team billing columns, member seat ids, request team stamping"
```

---

### Task 3: Migration 00033 part 2 — pooled quota in capture_webhook (+ integration tests)

The hot path. The function's signature and result statuses are frozen; only the internal quota branch changes.

**Files:**
- Modify: `supabase/migrations/00033_team_billing.sql` (append)
- Create: `apps/web/tests/integration/supabase-team-quota.test.ts`

**Interfaces:**
- Consumes: Task 2 columns.
- Produces: `capture_webhook` bills the oldest actively-subscribed team share and stamps `requests.team_id`; personal path byte-identical to `00023_response_rules.sql:17-156`.

- [ ] **Step 1: Write failing integration tests**

Create `apps/web/tests/integration/supabase-team-quota.test.ts`. Test harness mirrors `supabase-teams.test.ts:1-78` (service-role client from `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, `admin.auth.admin.createUser` for users — but do NOT set plan pro; teams no longer need it). Helper to call the procedure:

```typescript
async function capture(slug: string) {
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
    p_method: "POST",
    p_path: "/",
    p_headers: { "content-type": "application/json" },
    p_body: '{"n":1}',
    p_query_params: {},
    p_content_type: "application/json",
    p_ip: "127.0.0.1",
    p_received_at: new Date().toISOString(),
  });
  if (error) throw error;
  return data as { status: string; retry_after?: number | null };
}

async function activateTeam(teamId: string, seats: number) {
  await admin
    .from("teams")
    .update({
      subscription_status: "active",
      seats,
      request_limit: seats * 100_000,
      requests_used: 0,
      period_start: new Date().toISOString(),
      period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      polar_subscription_id: `sub_test_${teamId.slice(0, 8)}`,
    })
    .eq("id", teamId);
}
```

Setup: create owner (free plan, `request_limit` left at default 50), create team via `admin.rpc("create_team_with_owner", ...)`, create endpoint via `createEndpointForUser`, share it by direct insert into `team_endpoints`. Test cases:

1. **Team-billed capture**: activate team (seats 2 → limit 200k) → `capture(slug)` returns `status: "ok"`; `teams.requests_used` becomes 1; the inserted `requests` row has `team_id` = team id; owner's `users.requests_used` stays 0.
2. **Pool exhaustion**: set `requests_used = request_limit` → capture returns `status: "quota_exceeded"` with `retry_after` > 0; no request row inserted.
3. **Inactive team falls back to owner quota**: `subscription_status = null` → capture returns ok (free owner's lazy period starts), request row has `team_id` null, owner's `requests_used` becomes 1.
4. **Oldest active share wins**: second team, also active, shares the same endpoint with a later `shared_at` → capture bills team 1 only (team 1 `requests_used` +1, team 2 unchanged). Then deactivate team 1 → next capture bills team 2.
5. **Unshared endpoint untouched**: endpoint with no shares behaves exactly as before (owner quota).

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/web && npx vitest run tests/integration/supabase-team-quota.test.ts
```
Expected: FAIL — captures on the shared endpoint bill the owner (case 1: `teams.requests_used` stays 0, `team_id` null).

- [ ] **Step 3: Append the new capture_webhook to the migration**

Copy the ENTIRE function from `supabase/migrations/00023_response_rules.sql:17-156` verbatim, then make exactly these changes:

Add to `declare`:

```sql
  v_team            record;
  v_billing_team_id uuid;
```

Replace the owned-endpoint quota branch header (`elsif v_endpoint.user_id is not null then` ... down to the end of the user-quota block, lines 72–117 of 00023) with team resolution first:

```sql
  elsif v_endpoint.user_id is not null then
    -- Team billing: oldest share into a team with an active subscription wins.
    select t.id, t.period_end
      into v_team
      from public.team_endpoints te
      join public.teams t on t.id = te.team_id
     where te.endpoint_id = v_endpoint.id
       and t.subscription_status is not null
     order by te.shared_at asc
     limit 1;

    if v_team.id is not null then
      -- Pooled quota: atomic conditional increment on the single team row
      update public.teams
         set requests_used = requests_used + 1
       where id = v_team.id
         and requests_used < request_limit;

      if not found then
        v_retry_after := null;
        if v_team.period_end is not null and v_team.period_end > now() then
          v_retry_after := extract(epoch from (v_team.period_end - now()))::bigint * 1000;
        end if;

        return jsonb_build_object(
          'status', 'quota_exceeded',
          'retry_after', v_retry_after
        );
      end if;

      v_billing_team_id := v_team.id;
    else
      -- Personal quota path: UNCHANGED from 00023 (user lookup, start_free_period,
      -- check_and_decrement_quota, quota_exceeded with retry_after). Paste verbatim here.
    end if;
  end if;
```

And change the request insert to stamp the team:

```sql
  insert into public.requests (
    endpoint_id, user_id, team_id, method, path, headers, body, body_raw,
    query_params, content_type, ip, size, received_at
  ) values (
    v_endpoint.id, v_endpoint.user_id, v_billing_team_id, p_method, p_path, p_headers, p_body, p_body_raw,
    p_query_params, p_content_type, p_ip, v_size, p_received_at
  );
```

Everything else (ephemeral branch, expiry, mock/rules response build, endpoint counter) stays verbatim. `v_billing_team_id` is null on every non-team path.

- [ ] **Step 4: Apply migration, run tests to verify they pass**

```bash
set -a; source .env.local; set +a
/opt/homebrew/opt/libpq/bin/psql "$SUPABASE_DB_URL" -f supabase/migrations/00033_team_billing.sql
cd apps/web && npx vitest run tests/integration/supabase-team-quota.test.ts
```
Expected: PASS all 5 cases. Also re-run the untouched receiver contract: `cd apps/receiver-rs && cargo test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(db): capture_webhook bills team-shared endpoints against pooled team quota"
```

---

### Task 4: Migration 00033 part 3 — seats in accept_team_invite, team period resets, retention carve-outs

**Files:**
- Modify: `supabase/migrations/00033_team_billing.sql` (append)
- Create: `apps/web/tests/integration/supabase-team-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 2 columns.
- Produces: `accept_team_invite(p_user_id uuid, p_invite_id uuid, p_seat_id text default null)` returning `{"status": "accepted" | "not_found" | "full" | "inactive"}`; `process_billing_period_resets()` (same return shape) also handles teams; `cleanup_free_user_requests()` skips team-billed rows.

- [ ] **Step 1: Write failing integration tests**

Create `apps/web/tests/integration/supabase-team-lifecycle.test.ts` (same harness). Cases, all via `admin.rpc` / direct table ops:

1. **Accept blocked on inactive team**: pending invite, team `subscription_status` null → `accept_team_invite` returns `{status: "inactive"}`; invite still pending.
2. **Seats are the cap**: activate team with `seats: 2` (owner occupies 1) → first accept succeeds (`status: "accepted"`, membership row has `polar_seat_id` = passed value); second invite+accept for a third user returns `{status: "full"}` and rolls the invite back to pending.
3. **Team period renewal**: active team, `cancel_at_period_end` false, `period_end` in the past, `requests_used` 123 → run `admin.rpc("process_billing_period_resets")` → `requests_used` 0, `period_end` advanced 30 days, status still active.
4. **Team deactivation at period end**: `cancel_at_period_end` true, `period_end` past → after reset run: `subscription_status` null, `polar_subscription_id` null, `cancel_at_period_end` false.
5. **Free cleanup spares team rows**: free owner; insert two requests dated 10 days ago — one with `team_id`, one without → `admin.rpc("cleanup_free_user_requests")` deletes only the personal one.

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/web && npx vitest run tests/integration/supabase-team-lifecycle.test.ts
```
Expected: FAIL (RPC signature mismatch on `p_seat_id` / no `inactive` status / team rows untouched by resets / team request deleted).

- [ ] **Step 3: Append the three function replacements to the migration**

`accept_team_invite` — the signature changes, so drop the old overload first:

```sql
drop function if exists public.accept_team_invite(uuid, uuid);

create or replace function public.accept_team_invite(
  p_user_id uuid,
  p_invite_id uuid,
  p_seat_id text default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_team_id uuid;
  v_team record;
  v_member_count integer;
begin
  update public.team_invites
  set status = 'accepted'
  where id = p_invite_id
    and invited_user_id = p_user_id
    and status = 'pending'
  returning team_id into v_team_id;

  if v_team_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Lock team row first to serialize concurrent accepts
  select id, seats, subscription_status into v_team
  from public.teams
  where id = v_team_id
  for update;

  if v_team.subscription_status is null then
    update public.team_invites set status = 'pending' where id = p_invite_id;
    return jsonb_build_object('status', 'inactive');
  end if;

  perform 1 from public.team_members where team_id = v_team_id for update;

  select count(*) into v_member_count
  from public.team_members
  where team_id = v_team_id;

  if v_member_count >= v_team.seats then
    update public.team_invites set status = 'pending' where id = p_invite_id;
    return jsonb_build_object('status', 'full');
  end if;

  insert into public.team_members (team_id, user_id, role, polar_seat_id)
  values (v_team_id, p_user_id, 'member', p_seat_id)
  on conflict (team_id, user_id) do nothing;

  return jsonb_build_object('status', 'accepted');
end;
$$;

revoke all on function public.accept_team_invite(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.accept_team_invite(uuid, uuid, text) to service_role;
```

`process_billing_period_resets` — copy the function from `00005_billing_period_resets.sql:6-51` verbatim and add two team CTEs after the user ones, folding counts in (return shape unchanged; team deactivations count as `downgraded`, team renewals as `renewed`):

```sql
  with deactivated_teams as (
    update public.teams
    set
      subscription_status = null,
      polar_subscription_id = null,
      cancel_at_period_end = false,
      period_start = null,
      period_end = null
    where subscription_status is not null
      and cancel_at_period_end = true
      and period_end is not null
      and period_end <= now()
    returning id
  )
  select downgraded_count + count(*) into downgraded_count from deactivated_teams;

  with renewed_teams as (
    update public.teams
    set
      requests_used = 0,
      period_start = period_end,
      period_end = period_end + interval '30 days'
    where subscription_status is not null
      and cancel_at_period_end = false
      and period_end is not null
      and period_end <= now()
    returning id
  )
  select renewed_count + count(*) into renewed_count from renewed_teams;
```

`cleanup_free_user_requests` — copy from `00001_initial_schema.sql:300-314`, changing only the delete predicate:

```sql
  delete from public.requests
  where user_id in (select id from public.users where plan = 'free')
    and team_id is null
    and received_at < now() - interval '7 days';
```

- [ ] **Step 4: Apply migration, run tests to pass, commit**

```bash
set -a; source .env.local; set +a
/opt/homebrew/opt/libpq/bin/psql "$SUPABASE_DB_URL" -f supabase/migrations/00033_team_billing.sql
cd apps/web && npx vitest run tests/integration/supabase-team-lifecycle.test.ts tests/integration/supabase-billing-reset.test.ts
git add -A && git commit -m "feat(db): seat-capped invites, team period resets, team-aware retention"
```
(`supabase-billing-reset.test.ts` guards the unchanged personal-reset behavior.)

---

### Task 5: `team-billing.ts` — per-team Polar customer, checkout, seats, webhook apply

**Files:**
- Create: `apps/web/lib/supabase/team-billing.ts`
- Create: `apps/web/tests/integration/supabase-team-billing.test.ts` (webhook-apply paths, DB only)
- Test: `apps/web/lib/supabase/team-billing.test.ts` (unit, mocked Polar for checkout/seat paths)

**Interfaces:**
- Consumes: `createPolarClient`, `getPolarTeamsCheckoutConfig`, `unwrapPolarResult` from `@/lib/polar` (Task 1); `createAdminClient` from `./admin`.
- Produces (all exported from `@/lib/supabase/team-billing`):
  - `TEAM_SEAT_REQUEST_LIMIT = 100_000`
  - `class TeamBillingError extends Error { code: string }` — codes used: `team_not_found`, `not_owner`, `already_subscribed`, `no_subscription`, `not_scheduled`, `seats_below_members`, `invalid_seats`
  - `createTeamCheckout(userId: string, teamId: string, seats: number): Promise<string>` (returns checkout URL)
  - `cancelTeamSubscription(userId: string, teamId: string): Promise<void>`
  - `resubscribeTeam(userId: string, teamId: string): Promise<void>`
  - `updateTeamSeats(userId: string, teamId: string, seats: number): Promise<void>`
  - `assignTeamSeat(teamId: string, email: string, memberUserId: string): Promise<string | null>` (seat id; null when team has no subscription id)
  - `revokeTeamSeat(teamId: string, seatId: string | null, email: string): Promise<void>` (falls back to listing seats by subscription and matching email; logs and swallows Polar errors — our DB already gates access)
  - `revokeTeamSubscription(polarSubscriptionId: string): Promise<void>` (used by deleteTeam)
  - `extractTeamIdFromWebhook(data: Record<string, unknown>): string | null` (customer `metadata.teamId`, else `externalId` with `team:` prefix stripped, else null)
  - `applyTeamPolarWebhookEvent(eventType: string, teamId: string, data: Record<string, unknown>): Promise<void>`

- [ ] **Step 1: Write failing integration tests for the webhook-apply path**

`apps/web/tests/integration/supabase-team-billing.test.ts` (same harness; no Polar calls — `applyTeamPolarWebhookEvent` is pure DB):

1. `subscription.created` with `{ id: "sub_1", customerId: "cus_1", status: "active", seats: 5, currentPeriodStart: new Date(...), currentPeriodEnd: new Date(...), cancelAtPeriodEnd: false }` → team row: `polar_subscription_id` "sub_1", `polar_customer_id` "cus_1", status "active", seats 5, `request_limit` 500_000, periods set.
2. `subscription.updated` with `seats: 8` → seats 8, `request_limit` 800_000 (usage untouched).
3. `subscription.canceled` → `cancel_at_period_end` true, status "canceled".
4. `subscription.uncanceled` → back to active, flag false.
5. `subscription.revoked` → status null, `polar_subscription_id` null, flags/periods cleared; `seats`/`requests_used` retained.
6. `customer_seat.revoked` with `{ metadata: { userId: memberId } }` → that member's `team_members` row deleted; same event targeting the owner's userId → membership retained.
7. `customer_seat.claimed` with an email matching a membership whose `polar_seat_id` is null and `{ id: "seat_1" }` → seat id stored.

- [ ] **Step 2: Run to verify failure** (module doesn't exist)

```bash
cd apps/web && npx vitest run tests/integration/supabase-team-billing.test.ts
```

- [ ] **Step 3: Implement `team-billing.ts`**

Follow `billing.ts` conventions exactly (`asRecord`/`asNonEmptyString`/`parseEventTimestamp` — import nothing from `billing.ts`; copy the three tiny helpers plus `normalizeStoredSubscriptionStatus` into this file or extract them to `lib/supabase/billing-shared.ts` and re-import from both — extraction preferred, DRY). Core shapes:

```typescript
import { createPolarClient, getPolarTeamsCheckoutConfig, unwrapPolarResult } from "@/lib/polar";
import { createAdminClient } from "./admin";
import {
  asNonEmptyString,
  asRecord,
  normalizeStoredSubscriptionStatus,
  parseEventTimestamp,
} from "./billing-shared";

export const TEAM_SEAT_REQUEST_LIMIT = 100_000;

async function getTeamForOwner(userId: string, teamId: string) {
  const admin = createAdminClient();
  const { data: membership, error: memberError } = await admin
    .from("team_members")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .eq("role", "owner")
    .maybeSingle();
  if (memberError) throw memberError;
  if (!membership) throw new TeamBillingError("not_owner", "Only the team owner can manage billing");

  const { data: team, error } = await admin
    .from("teams")
    .select(
      "id, name, created_by, polar_customer_id, polar_subscription_id, subscription_status, seats, cancel_at_period_end"
    )
    .eq("id", teamId)
    .maybeSingle();
  if (error) throw error;
  if (!team) throw new TeamBillingError("team_not_found", "Team not found");
  return team;
}

async function ensureTeamPolarCustomerId(team: {
  id: string;
  name: string;
  created_by: string;
  polar_customer_id: string | null;
}): Promise<string> {
  if (team.polar_customer_id) return team.polar_customer_id;

  const admin = createAdminClient();
  const { data: owner, error } = await admin
    .from("users")
    .select("email")
    .eq("id", team.created_by)
    .maybeSingle();
  if (error) throw error;

  const polar = createPolarClient();
  const result = await polar.customers.create({
    email: owner?.email ?? "",
    name: team.name,
    externalId: `team:${team.id}`,
    metadata: { teamId: team.id },
  });
  const customer = unwrapPolarResult(result, "team customer creation");

  const { error: updateError } = await admin
    .from("teams")
    .update({ polar_customer_id: customer.id })
    .eq("id", team.id);
  if (updateError) throw updateError;

  return customer.id;
}

export async function createTeamCheckout(
  userId: string,
  teamId: string,
  seats: number
): Promise<string> {
  if (!Number.isInteger(seats) || seats < 1 || seats > 1000) {
    throw new TeamBillingError("invalid_seats", "Seats must be between 1 and 1000");
  }
  const team = await getTeamForOwner(userId, teamId);
  if (team.subscription_status !== null) {
    throw new TeamBillingError("already_subscribed", "Team already has an active subscription");
  }

  const polar = createPolarClient();
  const { appUrl, teamsProductId } = getPolarTeamsCheckoutConfig();
  const customerId = await ensureTeamPolarCustomerId(team);

  const result = await polar.checkouts.create({
    products: [teamsProductId],
    seats,
    successUrl: `${appUrl}/teams/${teamId}?subscribed=true`,
    customerId,
  });
  const checkout = unwrapPolarResult(result, "team checkout creation");
  return checkout.url;
}
```

`updateTeamSeats`: owner check → `no_subscription` if `polar_subscription_id` null → count `team_members` rows; `seats < memberCount` → `seats_below_members` → `polar.subscriptions.update({ id, subscriptionUpdate: { seats } })` → update `teams.seats` + `request_limit = seats * TEAM_SEAT_REQUEST_LIMIT` locally (webhook will confirm). `cancelTeamSubscription`/`resubscribeTeam`: mirror `cancelSubscriptionForUser`/`resubscribeForUser` in `billing.ts:202-243` operating on the team row. `assignTeamSeat`: read team's `polar_subscription_id` (null → return null), `polar.customerSeats.assign({ subscriptionId, email, immediateClaim: true, metadata: { userId: memberUserId, teamId } })` (exact param names per Task 1 verification), return seat id. `revokeTeamSeat`: try stored id; else `customerSeats.list` by subscription and match email; wrap all Polar errors in `console.error` + return (never throw — membership is already gone). `applyTeamPolarWebhookEvent`: switch mirroring `applyPolarWebhookEvent` but writing the `teams` row per the Step-1 test matrix; `customer_seat.revoked` deletes `team_members` where `user_id = metadata.userId` (fallback: match user by email) **unless** that user is the team's `created_by`; `customer_seat.assigned`/`claimed` stores `data.id` into `polar_seat_id` where null, matching member by `metadata.userId` then email.

- [ ] **Step 4: Unit tests for guard rails (mocked Polar)**

`apps/web/lib/supabase/team-billing.test.ts` with `vi.mock("@/lib/polar", ...)`: `createTeamCheckout` rejects seats 0 (`invalid_seats`) and non-owner callers (`not_owner`); `updateTeamSeats` rejects reducing below member count (`seats_below_members`). Follow the mocking style of `apps/web/app/api/endpoints/[slug]/route.test.ts`.

- [ ] **Step 5: Run all new tests to pass, typecheck, commit**

```bash
cd apps/web && npx vitest run tests/integration/supabase-team-billing.test.ts lib/supabase/team-billing.test.ts
pnpm typecheck
git add -A && git commit -m "feat(billing): team-billing lib — per-team Polar customer, checkout, seats, webhook apply"
```

---

### Task 6: Webhook route branches team events

**Files:**
- Modify: `apps/web/app/api/polar-webhook/route.ts:23`
- Test: `apps/web/app/api/polar-webhook/route.test.ts` (create)

**Interfaces:**
- Consumes: `extractTeamIdFromWebhook`, `applyTeamPolarWebhookEvent` (Task 5); existing `applyPolarWebhookEvent`.

- [ ] **Step 1: Write failing route test**

Mock `@polar-sh/sdk/webhooks` (`validateEvent` returns a fixed event), `@/lib/supabase/billing`, and `@/lib/supabase/team-billing` (style of `app/api/endpoints/[slug]/route.test.ts`). Cases: event whose `data.customer.metadata.teamId` is set → `applyTeamPolarWebhookEvent` called with that teamId, `applyPolarWebhookEvent` NOT called; event with `data.customer.externalId: "team:abc"` → team handler with `"abc"`; plain personal event → existing handler only.

- [ ] **Step 2: Run to verify failure, then implement**

Replace `route.ts:23`:

```typescript
    const data = event.data as Record<string, unknown>;
    const teamId = extractTeamIdFromWebhook(data);
    if (teamId) {
      await applyTeamPolarWebhookEvent(event.type, teamId, data);
    } else {
      await applyPolarWebhookEvent(event.type, event.data);
    }
```

with imports added. Everything else (validation, error mapping) unchanged.

- [ ] **Step 3: Run tests to pass, commit**

```bash
cd apps/web && npx vitest run app/api/polar-webhook/route.test.ts
git add -A && git commit -m "feat(billing): route Polar team-customer events to team webhook handler"
```

---

### Task 7: Gating swap — teams-crud + shared gating helpers + team deletion revokes subscription

**Files:**
- Create: `apps/web/lib/supabase/teams-gating.ts`
- Modify: `apps/web/lib/supabase/teams-crud.ts` (remove `requirePro`; billing fields on `Team`; deleteTeam revokes)
- Modify: `apps/web/lib/supabase/teams-types.ts:16-24` (`Team` interface)
- Modify: `apps/web/tests/integration/supabase-teams.test.ts` (harness + crud suites)

**Interfaces:**
- Consumes: `revokeTeamSubscription` (Task 5).
- Produces: `requireActiveTeam(teamId: string): Promise<string | null>` (error message or null) and `hasActiveTeamMembership(userId: string): Promise<boolean>` from `@/lib/supabase/teams-gating`; `Team` gains `subscriptionStatus: "active" | "canceled" | "past_due" | null; seats: number; requestsUsed: number; requestLimit: number; periodEnd: number | null; cancelAtPeriodEnd: boolean;` — `suspended === (subscriptionStatus === null)`.

- [ ] **Step 1: Update the integration-test harness expectations first (failing tests)**

In `supabase-teams.test.ts`: drop the `plan: "pro"` upgrade in `createTestUser` (teams are plan-independent now); add an `activateTeam(teamId, seats)` helper (same as Task 3's); rewrite the crud suite: `createTeam` succeeds for a free user; fresh team has `suspended: true`, `seats: 0`; after `activateTeam` `listTeamsForUser` reports `suspended: false`, `seats`, `requestLimit`. The old "Pro-gating" suite (from ~L985) becomes the subscription-gating suite in Tasks 8–9 — for now delete assertions that `createTeam` fails for free users. Run: expected FAIL (createTeam still returns "Teams require a Pro plan").

- [ ] **Step 2: Implement**

`teams-gating.ts`:

```typescript
import { createAdminClient } from "./admin";

export async function requireActiveTeam(teamId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("teams")
    .select("subscription_status")
    .eq("id", teamId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return "Team not found";
  if (data.subscription_status === null) return "This team needs an active Teams subscription";
  return null;
}

export async function hasActiveTeamMembership(userId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("team_members")
    .select("team_id, teams!inner(subscription_status)")
    .eq("user_id", userId)
    .not("teams.subscription_status", "is", null)
    .limit(1);

  if (error) throw error;
  return (data ?? []).length > 0;
}
```

(If the `teams!inner` embed doesn't resolve — check how other files embed joins; fallback: two queries, membership team ids then `teams.select("id").in("id", ids).not("subscription_status","is",null).limit(1)`.)

`teams-crud.ts`: delete `requirePro` and its `createTeam` call; `listTeamsForUser` selects the billing columns and maps `suspended: team.subscription_status === null` plus the new `Team` fields (drop the owner-plan batch lookup entirely); `createTeam` returns the new fields zeroed (`suspended: true`, `seats: 0`, ...). `deleteTeam`: before the delete, select `polar_subscription_id`; after a successful delete, `if (subId) await revokeTeamSubscription(subId)` (revoke failures log, never block deletion). Re-export `teams-gating` from the `teams.ts` barrel.

- [ ] **Step 3: Run suites to pass, typecheck, commit**

```bash
cd apps/web && npx vitest run tests/integration/supabase-teams.test.ts
pnpm typecheck
git add -A && git commit -m "feat(teams): subscription-based gating for team crud; deletion revokes Polar subscription"
```

---

### Task 8: Gating swap — invites and member removal drive Polar seats

**Files:**
- Modify: `apps/web/lib/supabase/teams-invites.ts` (`requirePro` out; seat lifecycle in `acceptInvite`; seat-aware `createInvite`)
- Modify: `apps/web/lib/supabase/teams-members.ts` (`removeTeamMember`, `leaveTeam` revoke seats)
- Modify: `apps/web/tests/integration/supabase-teams.test.ts` (invite/member suites)

**Interfaces:**
- Consumes: `requireActiveTeam` (Task 7); `assignTeamSeat`, `revokeTeamSeat` (Task 5); `accept_team_invite` 3-arg RPC (Task 4).
- Produces: `acceptInvite(userId, inviteId)` return type unchanged (`{ accepted: boolean; error?: string }`) — new error strings: `"This team needs an active Teams subscription"`, `"Team has no available seats — ask the owner to add seats"`.

- [ ] **Step 1: Failing tests**

Invite suite updates: `createInvite` fails on unsubscribed team with the subscription message; succeeds on active team without any user being Pro; fails with the no-seats message when `team_members` count ≥ `seats`. Accept suite: member (free plan) accepts on active team → membership exists; accept on inactive team → error mentions subscription. Member suite: `removeTeamMember`/`leaveTeam` still work for plan-free users. Polar must not be called in integration tests: `vi.mock("@/lib/supabase/team-billing", ...)` is NOT available in the integration harness — instead these tests run against teams whose `polar_subscription_id` is null, where `assignTeamSeat` returns null and `revokeTeamSeat` no-ops by design (that's the graceful-degradation path; the mocked-Polar unit tests in Task 5 cover the wired path). Run → FAIL.

- [ ] **Step 2: Implement**

`teams-invites.ts` `createInvite`: replace the owner-check's follow-up 25-cap block with:

```typescript
  const activeError = await requireActiveTeam(teamId);
  if (activeError) return { error: activeError };

  const { count: memberCount, error: countError } = await admin
    .from("team_members")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId);
  if (countError) throw countError;

  const { data: teamSeats, error: seatsError } = await admin
    .from("teams")
    .select("seats")
    .eq("id", teamId)
    .maybeSingle();
  if (seatsError) throw seatsError;
  if ((memberCount ?? 0) >= (teamSeats?.seats ?? 0)) {
    return { error: "Team has no available seats — ask the owner to add seats" };
  }
```

(The invitee-must-have-account lookup stays in Plan A; Plan B removes it.) `acceptInvite`: drop `requirePro`; fetch the invite's team + invited email; `const seatId = await assignTeamSeat(teamId, invitedEmail, userId);` then `admin.rpc("accept_team_invite", { p_user_id: userId, p_invite_id: inviteId, p_seat_id: seatId })`; map `"inactive"` → subscription error, `"full"` → seats error **and** compensating `await revokeTeamSeat(teamId, seatId, invitedEmail)`. `teams-members.ts`: in `removeTeamMember` and `leaveTeam`, select `polar_seat_id` + member email with the membership row, and after the successful delete call `revokeTeamSeat(teamId, polarSeatId, email)`.

- [ ] **Step 3: Run suites to pass, commit**

```bash
cd apps/web && npx vitest run tests/integration/supabase-teams.test.ts
git add -A && git commit -m "feat(teams): seat-gated invites; membership changes sync Polar seats"
```

---

### Task 9: Gating swap — endpoint sharing and access resolution

**Files:**
- Modify: `apps/web/lib/supabase/teams-endpoints.ts` (`requirePro` out everywhere; `resolveEndpointAccess:304-367`; `getSharedEndpointsForUser:218-231`; share/unshare guards)
- Modify: `apps/web/app/api/endpoints/route.ts:22-31` (share-metadata gate)
- Modify: `apps/web/lib/supabase/requests.ts:207-221` + list/get retention checks
- Modify: `supabase/migrations/00033_team_billing.sql` (append `search_requests` retention carve-out)
- Modify: `apps/web/tests/integration/supabase-teams.test.ts` (suspension/access suites)

**Interfaces:**
- Consumes: `requireActiveTeam`, `hasActiveTeamMembership` (Task 7).
- Produces: `resolveEndpointAccess` unchanged signature; non-owner access rule = membership in an active team the endpoint is shared with.

- [ ] **Step 1: Failing tests**

Rewrite the suspension suite: member of active team reads shared endpoint requests (both users plan-free) → allowed; deactivate team (`subscription_status: null`) → `resolveEndpointAccess` returns null for the member, owner unaffected; `getSharedEndpointsForUser` omits endpoints from inactive teams; `shareEndpointWithTeam` fails on inactive team. Retention: free owner + active team + team-billed request dated 10 days ago → `getRequestByIdForUser` (member and owner) returns it; personal request same age → null. Run → FAIL.

- [ ] **Step 2: Implement**

`teams-endpoints.ts`: `resolveEndpointAccess` — delete both `requirePro` calls (requester at L328, owner at L352-364); after finding `shareAccess` team ids, keep only teams with `subscription_status` non-null (adjust the `team_endpoints` query to join or follow with a `teams` filter query across ALL matching share teams — access passes if ANY sharing team the user belongs to is active, not just the first row; use `.in("id", shareTeamIds).not("subscription_status", "is", null).limit(1)`). Share/unshare guards swap `requirePro` for `requireActiveTeam(teamId)`. `getSharedEndpointsForUser` replaces the owner-plan filter (L218-231) with an active-teams filter. `app/api/endpoints/route.ts`: replace the `plan === "pro"` condition with a SPLIT gate — owned-endpoint share metadata (`getShareMetadataForOwnedEndpoints`) fetched when the user has ANY team membership (owners must always see/manage their own shares, even for lapsed teams — otherwise unshare is unreachable after the hard cutover); shared-with-me endpoints (`getSharedEndpointsForUser`) fetched only when `await hasActiveTeamMembership(auth.userId)`. `requests.ts`: select `team_id` in `getRequestByIdForUser` (add to the select at L232-234) and skip the cutoff when `row.team_id !== null`; in the two list functions that call `getUserCutoff(ownerId)` (`listRequestsForEndpointByUser` area L202+), when the owner is free change the single `gte("received_at", ...)` filter to `.or(\`team_id.not.is.null,received_at.gte.${cutoffIso}\`)` so team-billed rows survive the 7-day read cutoff. `search_requests` (append to migration 00033): re-create the function copying its current definition from `00021_search_index_compat.sql`, changing only the retention predicate inside the dynamic SQL from `r.received_at >= cutoff`-style to also pass rows where `r.team_id is not null` (exact edit: wherever `v_retention_cutoff` is applied, use `(%s is null or r.team_id is not null or r.received_at >= %s)` semantics matching the existing format-string style). Apply the migration again after editing.

- [ ] **Step 3: Run suites to pass; verify receiver still green; commit**

```bash
set -a; source .env.local; set +a
/opt/homebrew/opt/libpq/bin/psql "$SUPABASE_DB_URL" -f supabase/migrations/00033_team_billing.sql
cd apps/web && npx vitest run tests/integration/supabase-teams.test.ts tests/integration/supabase-team-quota.test.ts
cd ../../apps/receiver-rs && cargo test
git add -A && git commit -m "feat(teams): endpoint access + retention keyed to active team subscription"
```

---

### Task 10: Team billing API routes

**Files:**
- Create: `apps/web/app/api/teams/[teamId]/billing/checkout/route.ts`
- Create: `apps/web/app/api/teams/[teamId]/billing/cancel/route.ts`
- Create: `apps/web/app/api/teams/[teamId]/billing/resubscribe/route.ts`
- Create: `apps/web/app/api/teams/[teamId]/billing/seats/route.ts`
- Test: `apps/web/app/api/teams/[teamId]/billing/checkout/route.test.ts`

**Interfaces:**
- Consumes: `createTeamCheckout`, `cancelTeamSubscription`, `resubscribeTeam`, `updateTeamSeats`, `TeamBillingError` (Task 5); `authenticateSessionRequest` from `@/lib/api-auth` (session-token only — billing mutations reject API keys, same as personal billing).
- Produces: `POST .../checkout {seats} → {url}`; `POST .../cancel`; `POST .../resubscribe`; `POST .../seats {seats}` → 204.

- [ ] **Step 1: Failing route test** for checkout: 401 without session; 400 on `{seats: 0}`; happy path returns `{url}`; `TeamBillingError("not_owner")` → 403; `already_subscribed` → 409 (mock `@/lib/supabase/team-billing` and `@/lib/api-auth`, style of `app/api/endpoints/[slug]/route.test.ts`).

- [ ] **Step 2: Implement** — checkout route, mirroring `app/api/billing/checkout/route.ts`:

```typescript
import { authenticateSessionRequest } from "@/lib/api-auth";
import { PolarConfigError } from "@/lib/polar";
import { createTeamCheckout, TeamBillingError } from "@/lib/supabase/team-billing";

const ERROR_STATUS: Record<string, number> = {
  not_owner: 403,
  team_not_found: 404,
  already_subscribed: 409,
  invalid_seats: 400,
  no_subscription: 409,
  not_scheduled: 409,
  seats_below_members: 409,
};

export async function POST(request: Request, ctx: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await ctx.params;

  let seats: number;
  try {
    const body = (await request.json()) as { seats?: unknown };
    seats = typeof body.seats === "number" ? body.seats : NaN;
  } catch {
    seats = NaN;
  }

  try {
    const url = await createTeamCheckout(auth.userId, teamId, seats);
    return Response.json({ url });
  } catch (error) {
    if (error instanceof TeamBillingError) {
      return Response.json({ error: error.message }, { status: ERROR_STATUS[error.code] ?? 400 });
    }
    if (error instanceof PolarConfigError) {
      console.error("Team checkout misconfigured:", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }
    console.error("Team checkout failed:", error);
    return Response.json({ error: "Failed to start checkout" }, { status: 502 });
  }
}
```

cancel/resubscribe/seats follow the identical skeleton (share `ERROR_STATUS` via a small `apps/web/app/api/teams/[teamId]/billing/shared.ts`). `params` is a Promise in Next 16 route handlers — match how `app/api/teams/[teamId]/route.ts` reads it.

- [ ] **Step 3: Run tests, typecheck, commit**

```bash
cd apps/web && npx vitest run "app/api/teams/[teamId]/billing/checkout/route.test.ts"
pnpm typecheck
git add -A && git commit -m "feat(api): team billing routes — checkout, cancel, resubscribe, seats"
```

---

### Task 11: UI — team subscription card, page states, teams index

**Files:**
- Create: `apps/web/components/teams/team-subscription-card.tsx`
- Modify: `apps/web/app/teams/[teamId]/page.tsx` (suspension notices L400-439, member plan badge L466-473, card slot)
- Modify: `apps/web/app/teams/page.tsx` (upgrade wall L188-211, accept gating L297-309, badges L399-421)
- Modify: `apps/web/lib/analytics.ts` (one new event beside the teams events at L126-157)

**Interfaces:**
- Consumes: `Team` with billing fields (Task 7); billing routes (Task 10); `UsageDisplay` from `@/components/billing/usage-display`; `Button`/dialog primitives from `@/components/ui`; access token pattern from `upgrade-button.tsx`.
- Produces: `<TeamSubscriptionCard team={team} isOwner={boolean} accessToken={string | null} onChanged={() => void} />`.

- [ ] **Step 1: Build `TeamSubscriptionCard`** (client component, neobrutalist styles copied from the page's existing cards):
  - No subscription + owner: seat stepper (default 3, min 1) with live "`N × $12/seat/mo = $N·12/mo`" copy, Subscribe button → `POST /api/teams/${team.id}/billing/checkout` with `{seats}`, redirect to `url` (loading/error handling copied from `upgrade-button.tsx:12-34`, including the 5s redirect-failure reset); fire the new analytics event on click.
  - No subscription + member: static "This team needs an active Teams subscription — ask the owner to subscribe."
  - Subscribed: status line ("Active", "Cancels at period end", "Payment past due" per `subscriptionStatus`/`cancelAtPeriodEnd`), `Members X / Y seats`, pooled usage bar via `UsageDisplay` (`requestsUsed` / `requestLimit`), owner-only: seat stepper + "Update seats" → `POST .../seats`, cancel/resubscribe buttons → respective routes with confirm dialog (pattern: `manage-subscription-dialog.tsx`).
- [ ] **Step 2: Wire the pages** — `[teamId]/page.tsx`: render the card at the top of the settings column; replace the "owner isn't Pro" suspension notices (L400-425) and free-member notice (L428-439) with a single suspended banner ("Team suspended — no active subscription") when `team.suspended`; delete the per-member `Free — no access` badge block (L466-473) and drop `plan` from the member row type if now unused (`teams-types.ts` `TeamMember.plan` + its populate in `teams-members.ts:67`). `teams/page.tsx`: delete the Pro upgrade wall (L188-211) — always show team list + create form; "Upgrade to accept" buttons (L297-309) become plain Accept (accept errors from Task 8 surface inline); "Pro required" badges (L399-421) become "Suspended" badges keyed on `team.suspended`.
- [ ] **Step 3: Verify + commit**

```bash
pnpm typecheck && pnpm --filter web build && pnpm lint
git add -A && git commit -m "feat(web): team subscription card, seat management, subscription-gated team UI"
```

---

### Task 12: Copy — landing pricing, docs, changelog, CLAUDE.md

**Files:**
- Modify: `apps/web/app/page.tsx` (pricing section ~L555-626, teams video section copy ~L530-549)
- Modify: `apps/web/content/docs/plans-limits.mdx` (plans table L24-28, "only Pro feature is Teams" L30, team quota rules L63-67, caps L97-98)
- Modify: `apps/web/content/docs/teams.mdx` (gating + quota sections)
- Modify: `apps/web/lib/changelog.ts` (APP_VERSION minor bump + new web entry at top)
- Modify: `apps/web/package.json` (`version` — keep equal to APP_VERSION)
- Modify: `CLAUDE.md` (env table: `POLAR_TEAMS_PRODUCT_ID`; schema table: teams billing columns; plans description)

- [ ] **Step 1: Rewrite copy.** Pricing gains a third tier card: **Teams — $12/seat/mo** — "Pooled 100k requests per seat / 30 days", "Seats = members", "Shared endpoints & real-time collaboration", "Pro-level 31-day retention on team traffic". Remove every "Teams (Pro only)" phrase repo-wide (`grep -rn "Pro only" apps/web` and fix each hit). plans-limits.mdx: teams section states — any account can create a team; activating requires the Teams plan; pool = seats × 100k per 30 days tracked per team; member cap = seats; suspended teams keep data but block invites/sharing/member access. Changelog entry (track "web"): seat-based Teams plan, pooled quota, per-team billing. Minor version bump (0.x → 0.(x+1).0) in both files.
- [ ] **Step 2: Verify + commit**

```bash
pnpm --filter web build && pnpm lint && pnpm format:check
grep -rn "Pro only" apps/web --include="*.tsx" --include="*.mdx" | wc -l   # expect 0
git add -A && git commit -m "docs(web): teams pricing tier, plan docs, changelog for seat-based teams"
```

---

### Task 13: E2E updates + full verification sweep

**Files:**
- Modify: `apps/web/tests/e2e/teams.spec.ts`

- [ ] **Step 1: Update e2e expectations** — assertions referencing the Pro upgrade wall / "Teams require a Pro plan" / "Upgrade to accept" now assert the subscribe CTA ("Subscribe"), suspended badge, and seat copy ("$12/seat/mo"). Follow existing spec structure; do not add Polar-dependent flows (checkout is external).
- [ ] **Step 2: Full sweep**

```bash
pnpm typecheck && pnpm lint && pnpm build
make test
cd apps/web && npx vitest run tests/integration/
```
Expected: all green. Any failure is fixed before this task completes — no skips, no `.only`.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test(e2e): teams specs for subscription-gated UI"
```

---

## Deploy checklist (after merge — operator steps, not tasks)

1. **Polar: create the PRODUCTION product.** In the production (non-sandbox) Polar org, create "webhooks.cc Teams" with pricing type `seat_based` and a **volume** tier at $12/seat/mo — not a fixed price. This is the shape verified live against the sandbox product; a fixed-price product does not emit the seat lifecycle the app depends on. No benefits needed. Copy the product id → `POLAR_TEAMS_PRODUCT_ID` in the **production** env.

   Also restore production Polar credentials in the production env: `POLAR_ACCESS_TOKEN` and `POLAR_WEBHOOK_SECRET` must be the production org's values, and `POLAR_SANDBOX` must be unset or `false`. Dev's `.env.local` currently carries **sandbox** credentials left over from live verification — deploying without this step points production billing at the sandbox, where real checkouts silently do nothing.

2. **Polar: register/verify the production org webhook endpoint.** URL `https://webhooks.cc/api/polar-webhook`, secret = the production `POLAR_WEBHOOK_SECRET`. Subscribed event types must include `customer_seat.assigned`, `customer_seat.claimed`, and `customer_seat.revoked` **in addition to** the `subscription.*` events. The seat events are a new family for this feature — an endpoint that already exists for subscription billing will not be delivering them. Live verification only simulated these deliveries locally, so production delivery is unproven until the smoke test in step 8.

3. **Index out-of-band, before the migration.** On production run `create index concurrently if not exists requests_team on public.requests(team_id) where team_id is not null;` (plain `create index` inside the migration would SHARE-lock `requests` and block ingestion; the migration's `if not exists` then no-ops — same hazard/remedy as 00020's companion script).

4. **Apply `00033_team_billing.sql` to production Postgres with a lock timeout, at low traffic.** Prefix the run with `SET lock_timeout='5s';` (or apply during a quiet window). `alter table requests add column` takes a brief ACCESS EXCLUSIVE lock; if it queues behind a long-running reader, every concurrent capture blocks — and the receiver's fail-open returns 200 OK to senders while dropping the request, so a lock queue becomes silent capture loss rather than a visible error. Failing fast on the timeout and retrying is the safe mode.

5. **ACL audit on production (post-apply).** Query `pg_proc` ACLs for `capture_webhook`, `search_requests`, `search_requests_count`, `accept_team_invite`, `process_billing_period_resets`, `cleanup_free_user_requests`:

   ```sql
   select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.proacl
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('capture_webhook','search_requests','search_requests_count',
                       'accept_team_invite','process_billing_period_resets','cleanup_free_user_requests');
   ```

   Both search functions must show **service_role only** after this migration (00033 re-issues the revokes; `create or replace` alone would have preserved a stale anon/authenticated grant). `capture_webhook` is *not* hardened in this deploy — it is a tracked follow-up. Before any future hardening, first confirm which role the receiver's `DATABASE_URL` connects as: revoking a grant the receiver depends on would be masked by fail-open as silent capture loss, not an error.

6. **Confirm the per-minute pg_cron billing-resets job runs green post-migration.** Check `cron.job_run_details` for `process_billing_period_resets` — the migration changes the function it calls, so a signature or permission mismatch surfaces here as repeated failures rather than anywhere user-visible.

7. `make deploy-web`.

8. **Production smoke test (replaces the old sandbox e2e).** One real checkout and cancel against a throwaway test team on production: subscribe, invite/accept a seat, capture on a shared endpoint, watch the pool bar, then cancel and revoke. Tail the `/api/polar-webhook` logs throughout and confirm deliveries arrive for **both** `subscription.*` and `customer_seat.*` — this is the first proof that step 2's event subscription is actually wired up.

9. Existing teams show suspended with subscribe CTA — expected (hard cutover).

10. **Housekeeping:** this branch sets `APP_VERSION` to 0.27.0; the parked instant-URL branch (PR #262) carries 0.26.0. Whichever merges second reconciles `apps/web/lib/changelog.ts` and `apps/web/package.json`.
