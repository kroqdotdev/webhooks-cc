# Teams Seat-Based Billing — Design

**Date:** 2026-08-05
**Status:** Approved pending final review
**Scope:** Replace per-user Pro gating of teams with a Polar.sh seat-based Teams plan (pooled quota), add email-based team invites, and add email/password authentication. Team SSO is explicitly deferred (see Non-Goals).

## 1. Overview

Teams become a paid feature with their own subscription. Each team is billed through a Polar seat-based subscription at **$12/seat/month** (display price; actual price configured on the Polar product). Purchased seats define both the member cap and the team's pooled request quota (**seats × 100,000 requests per 30-day billing period**), tracked in a single row on the `teams` table. Members' personal plans (`free`/`pro`) become irrelevant to team access; `users.plan` values are unchanged.

Decisions locked in during brainstorming:

- **Pooled team quota** (not per-member entitlements): one usage row per team; all captures on team-shared endpoints draw from it.
- **Hard cutover**: existing teams are suspended until their owner subscribes. No grandfathering.
- **One Polar subscription per team**, owned by a **dedicated per-team Polar customer** (never the owner's personal customer).
- **$12/seat/month** display price.
- **Email invites** to any address (account no longer required at invite time), sent via the existing mailer.
- **Email/password auth** generally available via Supabase GoTrue's native email provider.

## 2. Non-Goals / Deferred

- **Team SSO (SAML/OIDC).** Own spec later. Earmarked vehicle: WorkOS SSO as an à-la-carte bolt-on that exchanges the WorkOS profile for a Supabase session (GoTrue admin `generateLink` → verify); alternative to evaluate then: GoTrue native SAML. Pricing decision recorded now: WorkOS costs ~$125/mo per connection, so SSO will carry either a flat surcharge or a minimum-seat requirement (~10+ seats breaks even at $12/seat); exact mechanics decided in that spec.
- Team roles beyond `owner`/`member`; billing-manager roles.
- Trials, annual billing, volume discounts.
- Pooled quota covering members' personal (unshared) endpoints.
- Teams support in SDK/CLI/MCP.
- Invite expiry.
- Reconciliation for seats assigned directly in Polar's customer portal to emails with no webhooks.cc membership (documented limitation: manage members in-app).

## 3. Billing Model

### 3.1 Polar objects

- **Product:** one seat-based product (fixed price per seat, $12/mo), sandbox + production. New env var `POLAR_TEAMS_PRODUCT_ID` (validated in `apps/web/lib/env.ts`, documented in `.env.example` and `CLAUDE.md`). Existing `POLAR_ACCESS_TOKEN` / `POLAR_WEBHOOK_SECRET` / `POLAR_SANDBOX` are reused.
- **Customer:** per team, created lazily before first checkout: `polar.customers.create({ email: owner.email, name: team.name, externalId: "team:<teamId>", metadata: { teamId } })`. Keeps team webhook routing unambiguous and avoids Polar permanently flagging the owner's personal customer as a `team`-type customer.
- **Subscription:** one per team, `seats` = purchased seats. Seat quantity changes via `polar.subscriptions.update({ id, seats })`. Polar rejects reducing below assigned seats; our UI pre-checks member count and instructs the owner to remove members first.
- **Seats:** assigned/revoked exclusively by our backend via `polar.customerSeats.assign({ subscriptionId, email, immediateClaim: true, metadata: { userId } })` and the corresponding revoke call. `immediateClaim` bypasses Polar's own invite emails entirely. The checkout buyer's seat auto-claims on Polar's confirmation page, which covers the owner.

Requires bumping `@polar-sh/sdk` (currently ^0.48.1, which predates `customerSeats`); verify `checkouts.create` `seats` param, `customerSeats.*`, and `customer_seat.*` webhook types after the bump.

### 3.2 Checkout flow

Team page → subscription card → seat-count picker (min 1) → `POST /api/teams/[teamId]/billing/checkout` (session token required, owner only) → `polar.checkouts.create({ products: [teamsProductId], seats, customerId: teamPolarCustomerId, successUrl: "<app>/teams/<teamId>?subscribed=true" })` → redirect. Activation happens via webhook, not the redirect.

### 3.3 Webhook handling

`/api/polar-webhook` (existing route, existing signature validation) branches: events whose customer has `externalId` starting `team:` (or `metadata.teamId`) go to a new team handler; everything else flows to the untouched personal-Pro handler.

| Event (team customer) | Effect on `teams` row |
| --- | --- |
| `subscription.created` / `updated` / `active` | `polar_subscription_id`, `subscription_status` (reuse `normalizeStoredSubscriptionStatus`), `seats`, `request_limit = seats × 100_000`, `period_start/end`, `cancel_at_period_end` |
| `subscription.canceled` / `uncanceled` | `cancel_at_period_end` + status, mirroring the personal handlers |
| `subscription.revoked` | `subscription_status = null` (team inactive), `polar_subscription_id = null`, `cancel_at_period_end = false`, periods nulled. `seats`/usage retained for history |
| `customer_seat.revoked` | remove the matching `team_members` row (match by `metadata.userId`, fallback email). If it targets the owner, ignore and log — owners can't be removed |
| `customer_seat.assigned` / `claimed` | store `seat.id` on the matching membership row if empty (covers the owner's auto-claimed seat); otherwise no-op |
| `order.*`, `benefit_grant.*` | ignored |

Handlers stay idempotent (pure column upserts keyed by team id), matching the existing personal handlers.

**Team-active definition:** `subscription_status IS NOT NULL` (`active`, `canceled`-until-period-end, and `past_due` all retain access), exactly mirroring how `users.plan = 'pro'` behaves today. `subscription.revoked` (or the cron fallback) is what deactivates.

### 3.4 Period rollover

Primary: Polar's `subscription.updated` on renewal refreshes periods. Fallback: extend `process_billing_period_resets()` (existing per-minute pg_cron job) — for teams with non-null status and `period_end <= now()`: if `cancel_at_period_end`, deactivate (as `subscription.revoked` above); else reset `requests_used = 0` and advance the period 30 days, mirroring the personal Pro branch.

## 4. Schema (new migration `00033_team_billing.sql`)

```sql
alter table public.teams add column
  polar_customer_id     text,
  polar_subscription_id text,
  subscription_status   text check (subscription_status in ('active','canceled','past_due')),
  seats                 integer not null default 0,
  requests_used         bigint  not null default 0,
  request_limit         bigint  not null default 0,
  period_start          timestamptz,
  period_end            timestamptz,
  cancel_at_period_end  boolean not null default false;
-- partial unique indexes on polar_customer_id / polar_subscription_id (mirror users)

alter table public.team_members add column polar_seat_id text;

alter table public.requests add column
  team_id uuid references public.teams(id) on delete set null;
-- partial index on requests(team_id) where team_id is not null (cleanup/retention scans)
```

Procedure changes (same migration):

- **`capture_webhook`** (latest version lives in `00023_response_rules.sql`): after the endpoint lookup, resolve the billing team — `team_endpoints` join `teams` where `subscription_status is not null`, `order by shared_at asc limit 1`. If found: atomic pool check-and-increment on that single `teams` row (`requests_used + 1 <= request_limit`), stamp `team_id` on the inserted request, and on exhaustion return `quota_exceeded` (Retry-After from the team's `period_end`). If none: existing owner-quota path, byte-for-byte unchanged. An endpoint shared into multiple active teams bills exactly one (oldest share) — deterministic, never double-billed. **The procedure's signature and result statuses are unchanged, so the Rust receiver needs zero changes.**
- **`accept_team_invite`**: replace the hardcoded `v_max_members := 25` with the team's `seats`, and require the team to be active. New `p_seat_id` parameter stored on the membership row. Returns `full` when members = seats (existing UX path: owner buys more seats).
- **`create_team_with_owner`**: unchanged (10-owned-teams cap stays). Team creation requires no plan — the team is inert until subscribed.
- **`handle_new_user`**: after the users upsert, link pending invites: `update team_invites set invited_user_id = new.id where lower(invited_email) = lower(new.email) and invited_user_id is null and status = 'pending'`. (`createInvite` lowercases `invited_email` at write time.)
- **`cleanup_free_user_requests`**: add `and team_id is null` — team-billed requests get Pro retention (31 days via the existing global cleanup) regardless of the endpoint owner's plan. Search cutoff functions (`00021_search_index_compat.sql`) treat `team_id is not null` rows as Pro-retention.

All new/changed functions keep `security definer set search_path = ''` and service-role-only grants. RLS on team tables stays deny-all.

## 5. Access Gating (replaces all Pro checks)

| Location | Today | New |
| --- | --- | --- |
| `teams-crud.ts` `requirePro()` (create) | caller must be Pro | removed — anyone creates a team shell |
| `teams-crud.ts` `listTeamsForUser` suspended flag | owner not Pro | `subscription_status is null` |
| `teams-invites.ts` `createInvite` | owner Pro + invitee has account + 25-cap | team active + members < seats (soft check; authoritative at accept) |
| `teams-invites.ts` `acceptInvite` | accepting user must be Pro | team active (checked in RPC); seat assigned in Polar first |
| `teams-endpoints.ts` share/unshare | owner Pro | team active |
| `teams-endpoints.ts` `resolveEndpointAccess` | requester Pro + owner Pro + membership | membership in an active team the endpoint is shared with (endpoint owner always passes regardless) |
| `app/api/endpoints/route.ts` share-metadata fetch | gated on requester `plan === "pro"` | gated on requester having ≥1 active-team membership |

Inactive team = invites, sharing, and member access to shared endpoints all blocked; data retained; reactivates instantly when a subscription becomes active.

## 6. Seat Lifecycle

- **Invite accept (ordering):** app checks seats availability → `customerSeats.assign(immediateClaim: true)` → `accept_team_invite(p_user_id, p_invite_id, p_seat_id)`. RPC failure (`full`/`not_found`) → compensating seat revoke. Assign failure → invite stays pending, error surfaced.
- **Remove/leave:** delete membership (existing paths) → revoke seat by stored `polar_seat_id` (fallback: list subscription seats, match email). Revoke failure logs loudly for manual cleanup but does not resurrect the membership (access is already gone; Polar seat is the follower, our DB is the source of truth).
- **Owner:** occupies the auto-claimed buyer seat; can never be removed or leave.

## 7. Email Invites

- `createInvite` accepts any syntactically valid email (existing 20/10min rate limit). Existing-account emails link `invited_user_id` immediately (as today); unknown emails leave it null for `handle_new_user` to link at signup.
- Every invite sends via the existing `sendEmail()` abstraction (`apps/web/lib/email/mailer.ts` — SMTP → Resend fallback → dev transport in non-prod): subject "«owner» invited you to «team» on webhooks.cc", plain-text + simple HTML, linking to `<app>/teams` (through login/signup redirect). Email send failure does not roll back invite creation (the invite still appears in-app); the error is logged and surfaced to the inviter as a warning. Generalize the mailer's from-address config (`AGENT_EMAIL_FROM` → shared `EMAIL_FROM`, keeping the old var as fallback).
- Pending invites do not reserve seats; seat enforcement happens at accept.
- Invitee path without an account: invite email → sign up (email/pass or OAuth) → trigger links the invite → `/teams` shows it pending → accept claims a seat.

## 8. Email/Password Auth

Generally available, not team-gated.

- **Supabase instance config (dev `/opt/lohsefar-dev-supabase` + production), not app code:** enable GoTrue email provider, `MAILER_AUTOCONFIRM=false` (verification required), min password length 8, SMTP credentials (same as app mailer), confirmation/recovery redirect URLs to the app.
- **App:** login page gains a password form beside the OAuth buttons — sign-in, sign-up, forgot-password (`signInWithPassword` / `signUp` / `resetPasswordForEmail`); new `/auth/confirm` route handler exchanging `token_hash` via `@supabase/ssr`, and `/auth/reset-password` page (`updateUser({ password })`).
- `handle_new_user()` fires for email signups automatically; `name` stays null and existing UI email-fallback applies. Account page, API keys, device auth: no changes.
- Local integration tests run GoTrue with autoconfirm on; the verification/reset email round-trip is covered manually against dev SMTP.

## 9. UI

- **Team page (`app/teams/[teamId]/page.tsx`):** new subscription card — unsubscribed: seat picker + "Subscribe" (checkout redirect); subscribed: status, seats used/total, pooled usage bar (reuse `usage-display.tsx`), seat adjuster, cancel/resubscribe (new `/api/teams/[teamId]/billing/{checkout,cancel,resubscribe,seats}` routes, session-token + owner only, mirroring `/api/billing/*`). "Owner isn't Pro" suspension banners → "no active subscription" states. Invite form accepts unknown emails.
- **Teams index (`app/teams/page.tsx`):** Pro upgrade wall removed; replaced with create-team + subscribe framing.
- **Landing pricing (`app/page.tsx`) and `content/docs/plans-limits.mdx` / `content/docs/teams.mdx`:** Teams tier at $12/seat/mo, pooled quota = seats × 100k/30d, seats-as-member-cap, retention rules. "Teams (Pro only)" copy removed everywhere.
- **Login page:** password form (section 8).
- Changelog: `APP_VERSION` minor bump + web entry at implementation time.

## 10. Error Handling & Failure Modes

- **Receiver fail-open is preserved**: DB errors during capture still return 200.
- Polar API outage: checkout/seat routes return 502 with actionable messages; capture path never calls Polar (pool state is local).
- Webhook out-of-order/duplicate delivery: handlers are idempotent upserts; `subscription.updated` carries full state.
- Seat/membership drift (e.g. revoke API call lost): our DB gates access, so drift only ever costs Polar-side seat occupancy, surfaced in the seats-used display; resolvable by remove+re-invite.
- Team deleted with active subscription: deletion revokes the Polar subscription first (`subscriptions.revoke` or cancel-immediate per SDK), then deletes rows (FKs cascade; `requests.team_id` → null).

## 11. Rollout

1. Bump `@polar-sh/sdk`; verify seat API surface.
2. Create seat-based Teams product in Polar sandbox + production; set `POLAR_TEAMS_PRODUCT_ID`.
3. Apply `00033_team_billing.sql` (psql, per project convention).
4. Configure GoTrue email provider + SMTP on dev, verify, then production.
5. `make deploy-web`.
6. Hard cutover is implicit: existing teams have `subscription_status = null` → suspended with "subscribe" CTA. No data migration needed.

## 12. Testing

- **Integration (`apps/web/tests/integration/`):** rewrite Pro-gating/suspension suites in `supabase-teams.test.ts` as subscription-gating suites; new team-billing webhook suite (event → teams row assertions, routing personal-vs-team); pooled-quota capture tests in SQL (single-team, multi-team oldest-share, exhaustion → `quota_exceeded`, inactive-team fallback to owner quota, `team_id` stamping, free-owner cleanup exclusion); invite-email tests via the existing dev-transport recorder; `handle_new_user` invite-linking test.
- **Unit:** webhook branch routing, seat math, invite accept compensation logic (mocked Polar client).
- **E2E (`tests/e2e/teams.spec.ts`):** unsubscribed-team states, subscribe CTA presence; email/pass login form.
- **Rust:** `cargo test` unchanged — asserts the receiver contract held.
