# Teams Email Invites: Plan B (Email Invites + Plan A Deferred Follow-ups) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Team invites work for any email address, not just registered users: the invitee gets an email, signs up (OAuth today, email/password once Plan C ships), the `handle_new_user` trigger links the pending invite to the new account, and accepting claims a Polar seat. This plan also absorbs every open follow-up deferred out of Plan A (PR #310): the personal Pro renewal reset race, the live-subscription webhook guard, pending-checkout idempotency, departed-member share cleanup, and the small-fix/test-coverage backlog.

**Architecture:** One new migration (`00036_invite_linking.sql`) extends `handle_new_user()` with invite linking and adds a `teams.pending_checkout` cache column. `createInvite` drops the invitee-must-have-account lookup, keys its duplicate checks on `invited_email`, and sends the invite through the existing `sendEmail()` abstraction (SMTP, Resend fallback, dev transport in non-prod), whose from-address generalizes from `AGENT_EMAIL_FROM` to a shared `EMAIL_FROM`. The follow-up hardening lands in `billing.ts` (personal renewal reset), `team-billing.ts` (subscription-event guards, checkout idempotency, seat-revocation share cleanup), and `teams-members.ts` / `teams-endpoints.ts` (departed-member share cleanup).

**Tech Stack:** Next.js 16 (App Router), Supabase (self-hosted Postgres via service-role admin client), Polar TypeScript SDK, nodemailer/Resend via the existing mailer, vitest unit + integration tests against the dev Supabase instance.

**Spec:** `docs/superpowers/specs/2026-08-05-teams-seat-billing-design.md` (section 7 primarily; sections 3.3, 6, 10 for the hardening tasks). Plan A shipped as PR #310 (migrations 00034/00035, deployed 2026-08-18 as v0.27.0). Plan C (email/password auth, spec section 8) stays a separate document.

## Global Constraints

- Branch: `feat/team-email-invites` off current `main`.
- Migration number: `00036_invite_linking.sql`. If main takes 00036 for something else before merge, renumber at merge time (this bit Plan A: its 00033 became 00034/00035).
- Apply migrations to dev with `/opt/homebrew/opt/libpq/bin/psql --set=ON_ERROR_STOP=1 "$SUPABASE_DB_URL" -f supabase/migrations/00036_invite_linking.sql`. No `create index concurrently` in this migration, so a plain transactional apply is fine. Dev Supabase runs at `/opt/lohsefar-dev-supabase` (start colima first if down: `colima start`). Load env with `set -a; source .env.local; set +a` from repo root.
- **Do NOT add `revoke`/`grant` statements to `handle_new_user()`.** It is an `auth.users` trigger executed by GoTrue's `supabase_auth_admin` role; the original definition in `00001_initial_schema.sql` deliberately carries no ACL statements, and revoking EXECUTE from public without granting it to `supabase_auth_admin` breaks every signup. All OTHER new/changed SQL keeps the Plan A convention (`security definer set search_path = ''`, service_role-only grants), but this trigger function is the documented exception.
- `capture_webhook()` is untouched in this plan. Zero Rust receiver changes; `cd apps/receiver-rs && cargo test` must pass untouched.
- Integration tests: `cd apps/web && npx vitest run tests/integration/<file>` (needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `.env.local`).
- Unit tests: `cd apps/web && pnpm test:unit`. **CI does not run the web unit suite**, so run it manually before every commit that touches `lib/` or components.
- The invite email is best-effort: a send failure never rolls back invite creation. It surfaces as a `warning` string, never as an error.
- Commit after every task (conventional commits, no Claude attribution).

---

### Task 1: Migration 00036 (invite linking in `handle_new_user` + `teams.pending_checkout`)

**Files:**

- Create: `supabase/migrations/00036_invite_linking.sql`
- Modify: `apps/web/lib/supabase/database.ts` (`teams` Row/Insert/Update gain `pending_checkout`)

**Interfaces:**

- Produces: `handle_new_user()` links pending `team_invites` rows by email at signup; `teams.pending_checkout jsonb` used by Task 8.

- [x] **Step 1: Write the migration**

```sql
-- ============================================================================
-- Migration 00036: Team invite linking + pending-checkout cache
--
-- 1. handle_new_user(): after the users upsert, claim any pending invites
--    addressed to the new account's email. createInvite lowercases
--    invited_email at write time, so a lower() comparison on the auth email
--    is exact. The trigger also fires on auth.users email UPDATEs (OAuth
--    re-login, future email change), which is desirable: a changed email
--    picks up invites addressed to the new address.
--
-- 2. teams.pending_checkout: cache of the most recent Polar checkout session
--    ({"id","url","seats","created_at"}), letting createTeamCheckout return
--    the same session instead of minting doubles. Nulled whenever a
--    subscription event applies (Task 7/8).
--
-- NOTE: no revoke/grant on handle_new_user: it runs as an auth.users
-- trigger under supabase_auth_admin, and the original 00001 definition
-- carries no ACL statements on purpose. Do not "harden" it.
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.users (id, email, name, image)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  )
  on conflict (id) do update set
    email = excluded.email,
    name  = coalesce(excluded.name, public.users.name),
    image = coalesce(excluded.image, public.users.image);

  -- Link pending team invites addressed to this email to the account.
  update public.team_invites
  set invited_user_id = new.id
  where lower(invited_email) = lower(new.email)
    and invited_user_id is null
    and status = 'pending';

  return new;
end;
$$;

alter table public.teams add column pending_checkout jsonb;

notify pgrst, 'reload schema';
```

- [x] **Step 2: Apply to dev**

```bash
/opt/homebrew/opt/libpq/bin/psql --set=ON_ERROR_STOP=1 "$SUPABASE_DB_URL" -f supabase/migrations/00036_invite_linking.sql
```

- [x] **Step 3: Add `pending_checkout: Json | null` to the `teams` Row/Insert/Update types in `database.ts`**

- [x] **Step 4: `pnpm typecheck`, then commit**

```bash
git add -A && git commit -m "feat(teams): migration 00036 with invite linking at signup and pending-checkout cache"
```

---

### Task 2: Mailer generalization + invite email builder + test hook

**Files:**

- Modify: `apps/web/lib/env.ts` (server schema + serverEnv passthrough: `EMAIL_FROM`)
- Modify: `apps/web/lib/email/smtp-transport.ts:79` and `apps/web/lib/email/resend-transport.ts:15` (from-address), `smtp-transport.ts:15` doc comment
- Modify: `apps/web/lib/email/dev-transport.ts` (new test hook)
- Create: `apps/web/lib/email/team-invite-email.ts`
- Modify: `.env.example` (EMAIL_FROM next to AGENT_EMAIL_FROM)

**Interfaces:**

- Produces: `buildTeamInviteEmail({ inviterEmail, teamName, invitedEmail, appUrl }): EmailMessage`, `getLastMessageForEmail(email): EmailMessage | null` (dev-transport test hook), `EMAIL_FROM` env var with `AGENT_EMAIL_FROM` as fallback.

- [x] **Step 1: Generalize the from-address**

In `env.ts`, next to `AGENT_EMAIL_FROM`, add `EMAIL_FROM: z.string().optional(),` (schema and the serverEnv construction site). In both transports replace `serverEnv().AGENT_EMAIL_FROM` with:

```typescript
from: serverEnv().EMAIL_FROM ?? serverEnv().AGENT_EMAIL_FROM,
```

`AGENT_EMAIL_FROM` keeps its `"webhooks.cc <noreply@webhooks.cc>"` default, so nothing changes for deployments that only set the old var. Update the `smtp-transport.ts` header comment accordingly, and add to `.env.example` under the existing line:

```bash
# Shared from-address for all outbound email (falls back to AGENT_EMAIL_FROM)
# EMAIL_FROM=webhooks.cc <noreply@webhooks.cc>
```

- [x] **Step 2: Invite email builder**

`team-invite-email.ts` exports a pure builder (no I/O, unit-testable):

```typescript
import type { EmailMessage } from "./mailer";

export function buildTeamInviteEmail(params: {
  inviterEmail: string;
  teamName: string;
  invitedEmail: string;
  appUrl: string;
}): EmailMessage {
  const { inviterEmail, teamName, invitedEmail, appUrl } = params;
  const link = `${appUrl}/teams`;
  return {
    to: invitedEmail,
    subject: `${inviterEmail} invited you to ${teamName} on webhooks.cc`,
    text: [
      `${inviterEmail} invited you to join the team "${teamName}" on webhooks.cc,`,
      `a webhook inspection and testing service.`,
      ``,
      `Sign in (or create an account) with this email address (${invitedEmail})`,
      `and the invite will be waiting for you at ${link}`,
    ].join("\n"),
    html: /* simple single-paragraph HTML mirroring the text, with one anchor to `link` */,
  };
}
```

Escape `inviterEmail`/`teamName` in the HTML variant (team names are user input).

- [x] **Step 3: Dev-transport test hook**

`dev-transport.ts` already records the last message per recipient. Export the whole message so the invite tests can assert subject/body, not just OTPs:

```typescript
export function getLastMessageForEmail(email: string): EmailMessage | null {
  return lastMessageByEmail.get(email.toLowerCase()) ?? null;
}
```

- [x] **Step 4: Unit test the builder** (new `team-invite-email.test.ts` beside it: subject shape, link present, HTML escapes a team name containing `<script>`), run `pnpm test:unit`, `pnpm typecheck`, commit:

```bash
git add -A && git commit -m "feat(email): shared EMAIL_FROM, team invite email builder, dev-transport message hook"
```

---

### Task 3: `createInvite` accepts unknown emails and sends the invite email

**Files:**

- Modify: `apps/web/lib/supabase/teams-invites.ts` (`createInvite`)
- Modify: `apps/web/app/api/teams/[teamId]/invite/route.ts` (pass `warning` through)
- Modify: `apps/web/lib/supabase/teams-invites.test.ts`

**Interfaces:**

- Produces: `createInvite(userId, teamId, email): Promise<{ invite?: TeamInvite; warning?: string; error?: string }>`; the one behavior change to the return shape is the optional `warning`.

- [x] **Step 1: Rework the lookup chain in `createInvite`**

Normalize once at the top: `const normalizedEmail = email.trim().toLowerCase();` and use it everywhere (today the code mixes `email.toLowerCase()` and `email.toLowerCase().trim()`).

- The owner check, `requireActiveTeam`, and the seats-cap soft check stay byte-for-byte.
- The user lookup by email stays but its miss is no longer an error: **delete the `if (!invitedUser) return { error: "No account found with that email address" }` branch.** `invitedUser` becomes `{ id, email } | null`.
- Self-invite check: only when `invitedUser` is found (`invitedUser.id === userId`). Also reject when `normalizedEmail` equals the inviter's own email (fetch `inviterUser` earlier; it is already loaded later in the function, hoist it) so an owner cannot invite their own address before the row exists.
- Already-a-member check: only when `invitedUser` is found.
- **Duplicate-pending check keys on email, not user id** (an unknown-email invite has `invited_user_id = null`):

```typescript
const { data: existingInvite, error: existingInviteError } = await admin
  .from("team_invites")
  .select("id")
  .eq("team_id", teamId)
  .eq("invited_email", normalizedEmail)
  .eq("status", "pending")
  .maybeSingle();
```

Error copy for both this branch and the `23505` race branch becomes "A pending invite already exists for this email".

- Insert `invited_user_id: invitedUser?.id ?? null`. The declined/accepted-row cleanup before insert stays (unique constraint is `(team_id, invited_email)`).
- Response mapping: `invitedEmail: invite.invited_email` (today it reads `invitedUser.email`, which no longer exists for unknown emails).

- [x] **Step 2: Send the invite email after a successful insert**

After the insert succeeds, build and send, best-effort:

```typescript
let warning: string | undefined;
try {
  await sendEmail(
    buildTeamInviteEmail({
      inviterEmail: inviterUser?.email ?? "A webhooks.cc user",
      teamName: teamData.name,
      invitedEmail: normalizedEmail,
      appUrl: publicEnv().NEXT_PUBLIC_APP_URL,
    })
  );
} catch (error) {
  console.error("[teams-invites] invite email send failed", { teamId, error });
  warning = "Invite created, but the notification email could not be sent";
}

return { invite: { ... }, warning };
```

The invite always exists in-app regardless of delivery; that is the spec's contract. In non-production the dev transport records instead of sending, so local invites never email anyone.

- [x] **Step 3: Route passes the warning through**

In the invite route's success branch return `Response.json({ ...result.invite, warning: result.warning })`. The existing rate limiting (20 per 10 min per user, `checkRateLimitByKeyWithInfo`) is untouched and is what bounds outbound invite email volume.

- [x] **Step 4: Update `teams-invites.test.ts`**

Cases to add or adjust: unknown email creates an invite with null `invited_user_id`; duplicate pending invite for the same email rejected regardless of account existence; known email still links `invited_user_id` immediately; self-invite by own email rejected; email-send failure returns `warning` and still returns `invite`. Run `pnpm test:unit`, `pnpm typecheck`.

- [x] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(teams): invite any email address, send invite email with best-effort delivery"
```

---

### Task 4: Team page UI (invite form copy + warning surfacing)

**Files:**

- Modify: `apps/web/app/teams/[teamId]/page.tsx` (invite section, ~L515-575)

- [x] **Step 1: Copy changes**

The tooltip at ~L540 currently reads "Enter the email of a registered webhooks.cc user...". Replace with: "Invite anyone by email. If they don't have an account yet, the invite is waiting after they sign up with that address." Pending-invite rows already render `invite.invitedEmail` (works for unlinked invites without changes).

- [x] **Step 2: Surface the warning**

`handleInvite` parses the response body; when `warning` is present show it via the existing `inviteMessage` state as a distinct visual state (success styling with the warning text, or a third `"warning"` type, matching the page's existing message pattern), instead of the plain success message.

- [ ] **Step 3: Verify in the browser** against dev (`pnpm dev:web`): invite an unknown email, see the pending row appear and the dev-transport log line in the server console. `pnpm typecheck`, commit:

```bash
git add -A && git commit -m "feat(teams): invite form accepts unknown emails, surfaces email-delivery warnings"
```

---

### Task 5: Integration tests (invite email, signup linking, full unknown-email flow)

**Files:**

- Modify: `apps/web/tests/integration/supabase-teams.test.ts` (or a new `supabase-team-invites.test.ts` if the suite is getting long)

- [x] **Step 1: Invite email recording test**

Call `createInvite` directly (dev transport is active under vitest) and assert via `getLastMessageForEmail` that the recorded message has the invited address, the inviter email in the subject, and the `/teams` link in the body. Reset with `__resetEmailTestStore()` between cases.

- [x] **Step 2: `handle_new_user` linking test**

Create a pending invite for a fresh random email with `invited_user_id = null` (through `createInvite`), then create the auth user with that email via the service-role client: `admin.auth.admin.createUser({ email, email_confirm: true })` (see `supabase-auth.test.ts` for the established pattern of creating and cleaning up auth users). Assert the invite row's `invited_user_id` now equals the new user's id. Also assert the negative: a `declined` invite for the same email does not get linked.

- [x] **Step 3: End-to-end unknown-email flow**

Subscribed team (seed the `teams` row billing columns directly, as the Plan A suites do) → invite unknown email → sign the user up → `listPendingInvitesForUser` shows it → `acceptInvite` succeeds and the member row exists. Mock/stub the Polar seat assign the way `supabase-team-lifecycle.test.ts` handles it (or run with a null seat id path if the team fixture has no `polar_subscription_id`, which makes `assignTeamSeat` return null by design).

- [x] **Step 4: Run the touched suites, commit**

```bash
cd apps/web && npx vitest run tests/integration/supabase-teams.test.ts
git add -A && git commit -m "test(teams): invite email recording, signup linking, unknown-email accept flow"
```

---

### Task 6 (deferred follow-up): personal Pro renewal reset race in `billing.ts`

Plan A fixed the team half of this in `applyTeamSubscriptionState`; the personal handler has the identical race: `subscription.updated` on renewal writes a future `period_end` **without resetting `requests_used`**, which blinds the per-minute cron fallback (it only resets rows with `period_end <= now()`), so a webhook-renewed Pro user keeps last month's usage.

**Files:**

- Modify: `apps/web/lib/supabase/billing.ts` (`subscription.created`/`subscription.updated` branch, ~L229-253)
- Modify: `apps/web/app/api/polar-webhook/route.test.ts` (or the billing unit suite, following its existing mock pattern)

- [x] **Step 1: Port the team-half period logic**

Before the update, fetch the stored row (`period_start`, `polar_subscription_id`, `subscription_status`) for the resolved user. Then mirror `team-billing.ts` exactly:

- `isNewSubscription`: event `data.id` non-null and different from stored `polar_subscription_id` → reset `requests_used: 0`.
- `isRenewal`: same subscription, incoming `currentPeriodStart` strictly later than stored `period_start` → reset `requests_used: 0`.
- `isStalePeriod`: incoming `currentPeriodStart` strictly older than stored → keep the stored period bounds (`period_start`/`period_end: undefined` in the update), do not roll the period backwards.
- Status parity: `subscription_status: normalizeStoredSubscriptionStatus(data.status) ?? stored.subscription_status ?? "active"`. Today an unrecognized status writes null; preserve the stored value instead, matching the team handler's rationale.

Everything else in the branch (plan `"pro"`, `PRO_REQUEST_LIMIT`, `cancel_at_period_end`) is unchanged.

- [x] **Step 2: Tests**

Renewal event resets usage; same-period repeat event does not; stale (older `currentPeriodStart`) event leaves stored bounds and usage; new subscription id resets usage; unknown status preserves stored status. Run the suite + `pnpm test:unit`.

- [x] **Step 3: Commit**

```bash
git add -A && git commit -m "fix(billing): reset personal Pro usage on webhook renewal, reject stale period bounds"
```

---

### Task 7 (deferred follow-up): live-subscription guard on team `created`/`updated`/`active`

Closes Plan A follow-up #5: a stale `subscription.updated` after `subscription.revoked` can re-activate a team with a past period, which the cron then renews unbilled forever. Also closes the DB half of the double-checkout gap (#3): a second subscription's events must never overwrite the one the team is actually paying for.

**Files:**

- Modify: `apps/web/lib/supabase/team-billing.ts` (`applyTeamSubscriptionState` gains an `eventType` parameter; `applyTeamPolarWebhookEvent` passes it)
- Modify: `apps/web/lib/supabase/team-billing.test.ts`

- [x] **Step 1: Two guards at the top of `applyTeamSubscriptionState`, after the team row load**

```typescript
// G1 (foreign subscription): the team already tracks a live subscription and
// this event describes a different one. Applying it would let a stale
// cross-subscription event (or a double-checkout's second subscription)
// overwrite the row that gates access and billing. The Polar-side orphan is
// deliberately NOT auto-revoked; this log line is the remediation signal.
if (
  team.polar_subscription_id !== null &&
  team.subscription_status !== null &&
  subscriptionId !== null &&
  subscriptionId !== team.polar_subscription_id
) {
  console.error("[team-billing] ignoring event for foreign subscription", {
    teamId, eventType, storedSubscriptionId: team.polar_subscription_id, eventSubscriptionId: subscriptionId,
  });
  return;
}

// G2 (post-revoke stale event): a deactivated team (revoked nulls both the
// status and the stored id) may only be reactivated by subscription.created,
// i.e. a genuinely new subscription. A delayed `updated`/`active` for the
// revoked subscription would otherwise re-open the pool with bounds the cron
// then renews unbilled. Trade-off: if Polar never delivers `created` for a
// new subscription, the team stays visibly inactive (activation-wait timeout
// on the team page) until redelivery: a loud failure instead of a silent
// unbilled reactivation.
if (
  team.polar_subscription_id === null &&
  team.subscription_status === null &&
  eventType !== "subscription.created"
) {
  console.warn("[team-billing] ignoring non-created event for unsubscribed team", {
    teamId, eventType, eventSubscriptionId: subscriptionId,
  });
  return;
}
```

Note the mixed states (one of id/status null, the other not) intentionally fall through to the normal apply: they can only arise from partial manual intervention and the full-state upsert is the correct repair.

- [x] **Step 2: Tests**

In `team-billing.test.ts`: foreign-subscription `updated` against an active team leaves the row untouched; post-revoke `updated` and `active` are ignored; post-revoke `created` activates (fresh id, usage reset via the existing `isNewSubscription` path); first-ever `created` on a never-subscribed team still works; existing renewal/stale-period cases still pass. Check whether any existing integration test activates a team via a simulated `subscription.updated` alone; if so, switch it to `subscription.created` (that is now the contract).

- [x] **Step 3: Commit**

```bash
git add -A && git commit -m "fix(teams): guard subscription events against foreign and post-revoke stale deliveries"
```

---

### Task 8 (deferred follow-up): pending-checkout idempotency in `createTeamCheckout`

Closes the "pending-checkout tracking" half of Plan A follow-up #3 and the review round's deferred `createTeamCheckout` idempotency. Best-effort by design: it collapses the common double-click/double-tab case by reusing the open session; the G1 guard from Task 7 plus its log line remain the backstop if two sessions are still completed.

**Files:**

- Modify: `apps/web/lib/supabase/team-billing.ts` (`createTeamCheckout`, `applyTeamSubscriptionState`, `BILLING_TEAM_COLUMNS`/`BillingTeam`)
- Modify: `apps/web/lib/supabase/team-billing.test.ts`

- [x] **Step 1: Reuse an open checkout session**

Add `pending_checkout` to `BILLING_TEAM_COLUMNS` and the `BillingTeam` pick. In `createTeamCheckout`, after the `already_subscribed` check:

```typescript
const PENDING_CHECKOUT_TTL_MS = 30 * 60_000;

const pending = asRecord(team.pending_checkout);
const pendingUrl = pending ? asNonEmptyString(pending.url) : null;
const pendingAt = pending ? Date.parse(asNonEmptyString(pending.created_at) ?? "") : NaN;
if (
  pendingUrl &&
  pending?.seats === seats &&
  Number.isFinite(pendingAt) &&
  Date.now() - pendingAt < PENDING_CHECKOUT_TTL_MS
) {
  return pendingUrl;
}
```

A different seat count or an expired cache falls through and mints a fresh session. After a successful `checkouts.create`, store the cache best-effort (a failed write logs and still returns the URL):

```typescript
await updateTeamById(team.id, {
  pending_checkout: { id: checkout.id, url: checkout.url, seats, created_at: new Date().toISOString() },
});
```

- [x] **Step 2: Clear the cache when a subscription lands**

In `applyTeamSubscriptionState`'s final `updateTeamById`, add `pending_checkout: null`. Add the same to the `subscription.revoked` update (a stale pre-revoke session must not be resurrected by the reuse path after resubscribe).

- [x] **Step 3: Tests**

Unit: second call with same seats inside the TTL returns the cached URL and does not call `checkouts.create`; different seats mints fresh; expired `created_at` mints fresh; subscription apply nulls the cache. Run `pnpm test:unit`.

- [x] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(teams): idempotent checkout reusing the open Polar session within 30 minutes"
```

---

### Task 9 (deferred follow-up): departed-member share cleanup

Closes Plan A follow-up #2: leave/remove currently keeps the departing member's `team_endpoints` rows, so their traffic keeps draining the team pool after they are gone.

**Files:**

- Modify: `apps/web/lib/supabase/teams-endpoints.ts` (new `removeMemberShares` helper; the file already owns `team_endpoints` and does not import `team-billing`, so both callers below can use it without an import cycle)
- Modify: `apps/web/lib/supabase/teams-members.ts` (`removeTeamMember`, `leaveTeam`)
- Modify: `apps/web/lib/supabase/team-billing.ts` (`applySeatRevocation`: the webhook-driven removal path must clean up the same way)
- Modify: `apps/web/lib/supabase/teams-members.test.ts`, integration suite

- [x] **Step 1: The helper**

```typescript
/**
 * Deletes the share rows a departed member created for this team. Called after
 * the membership row is already gone, so failures log and swallow (throwing
 * would report failure for a removal that committed); until the rows are gone
 * the departed sharer's traffic keeps billing the team pool, which is exactly
 * the state we were in before this cleanup existed.
 */
export async function removeMemberShares(teamId: string, userId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("team_endpoints")
    .delete()
    .eq("team_id", teamId)
    .eq("shared_by", userId);
  if (error) {
    console.error("[teams-endpoints] failed to remove departed member's shares", { teamId, userId, error });
  }
}
```

- [x] **Step 2: Call it from all three removal paths**

In `removeTeamMember` and `leaveTeam`: after the successful membership delete, `await removeMemberShares(teamId, <departed user id>);` then the existing `releaseMemberSeat`. In `applySeatRevocation` (team-billing.ts): after the membership delete succeeds, call the same helper.

Behavior change to note in the commit body: when the sharer departs, the endpoint immediately stops being shared with (and billed to) that team. The Plan A mitigation (departed sharers keep the unshare control) becomes moot for new departures but stays for pre-existing orphaned rows.

- [x] **Step 3: Tests**

Unit (`teams-members.test.ts`): removal and leave both delete the share rows; a share-delete failure does not fail the removal. Integration: member shares an endpoint into the team, leaves, `team_endpoints` row is gone; other members' shares are untouched. Run both suites.

- [x] **Step 4: Commit**

```bash
git add -A && git commit -m "fix(teams): delete a departed member's endpoint shares on remove/leave/seat-revoke"
```

---

### Task 10 (deferred follow-up): small-fix batch

Four independent fixes from Plan A follow-up #6; one commit each or one batch commit, implementer's call.

**Files:**

- Modify: `apps/web/lib/polar.ts`, `apps/web/app/api/teams/[teamId]/billing/checkout/route.ts`
- Modify: `apps/web/components/dashboard/endpoint-switcher.tsx`
- Modify: `apps/web/app/teams/[teamId]/page.tsx` (`fetchData`)
- Modify: `apps/web/tests/integration/supabase-teams.test.ts` (anon-rejection asserts, ~L1786-1834)

- [x] **Step 1: Surface Polar validation detail on checkout 502**

Add `describePolarError(error: unknown): string | null` to `lib/polar.ts`: inspect the installed SDK's error classes (verify names in `node_modules/@polar-sh/sdk`; validation failures carry a `detail` array or body text; the motivating case is Polar rejecting an unroutable owner email at `customers.create`). Return a short human-readable string or null, never raw response bodies over ~200 chars. In the checkout route's final catch, include it: `Response.json({ error: "Failed to start checkout", detail }, { status: 502 })`, and log it. The team page's checkout error handler shows `detail` when present.

- [x] **Step 2: Endpoint-switcher value/list mismatch**

`endpoint-switcher.tsx` sets `<Select value={currentSlug || allEndpoints[0]?.slug}>` with the raw `?endpoint=` param. When the param names a slug that is not in the list (deleted endpoint, stale link), the Select's value matches no `SelectItem`, so the trigger renders the empty placeholder while the dashboard itself (which resolves `endpoints.find(...) ?? endpoints[0]`) shows the first endpoint. Fix by resolving the same way the dashboard does:

```typescript
const resolvedSlug =
  allEndpoints.find((ep) => ep.slug === currentSlug)?.slug ?? allEndpoints[0]?.slug;
```

and pass `resolvedSlug` as the Select value. Verify the fallback ordering matches the dashboard's `endpoints` array ordering (both derive from `fetchDashboardEndpoints`; confirm the dashboard flattens owned-then-shared and mirror it).

- [x] **Step 3: Team page `fetchData` error state**

`fetchData` has no catch: one rejected fetch leaves the page permanently on whatever partial state it had, with no path to recovery, and non-ok responses are silently skipped. Add a `loadError` state set in a catch (and when the teams response is not ok, since the page is unusable without the team row); render an error card with a Retry button that calls `fetchData()` again. Keep partial data that did load.

- [x] **Step 4: Anon-rejection asserts**

The four anon-client tests only assert empty `data`, which passes under RLS filtering AND under revoked grants, so they cannot detect a grant regression. First verify against dev what the anon client actually gets for `teams`/`team_members`/`team_invites`/`team_endpoints` (Plan A's hardening revoked table grants, which surfaces as PostgREST error code `42501` insufficient_privilege). Then pin the stronger assertion that actually holds: capture `error` and `expect(error?.code).toBe("42501")` alongside the empty-data check. If dev shows RLS-only behavior (null error) for any table, keep the data assertion there and note it inline rather than pinning a false expectation.

- [x] **Step 5: Run `pnpm test:unit`, the integration suite, `pnpm typecheck`; verify switcher + team page fixes in the browser. Commit** (tests + typecheck done; browser spot-check still open)

```bash
git add -A && git commit -m "fix(web): checkout error detail, switcher slug resolution, team page error state, anon-grant asserts"
```

---

### Task 11 (deferred follow-up): test-coverage gaps (Plan A T3/T5) + deleted-team webhook no-ops

No production code changes expected in this task; it pins behavior that already exists.

**Files:**

- Modify: `apps/web/tests/integration/supabase-team-quota.test.ts`
- Modify: `apps/web/lib/supabase/team-billing.test.ts`

- [x] **Step 1: `retry_after` null branch (SQL)**

In the pooled-quota suite: a team row with non-null `subscription_status`, `request_limit` exhausted, and `period_end` null → `capture_webhook` returns `quota_exceeded` with a null/absent `retry_after`. (The state should be unreachable through the single-statement webhook writes, but the SQL branch exists and the receiver maps it; pin it.)

- [x] **Step 2: `shared_at` ordering (SQL)**

Two active teams share the same endpoint; set their `team_endpoints.shared_at` values explicitly (distinct timestamps) and assert the capture bills, and stamps `requests.team_id` with, the older share, in both insertion orders. Equal-timestamp determinism is documented as out of scope (see the triage table below).

- [x] **Step 3: Subscription-management unit tests**

`team-billing.test.ts` gains: `cancelTeamSubscription` (Polar update called with `cancelAtPeriodEnd: true`, row flag set; `no_subscription` error), `resubscribeTeam` (`not_scheduled` error branch; success clears the flag), `revokeTeamSubscription` (calls `subscriptions.revoke`).

- [x] **Step 4: Deleted-team webhook no-ops**

For each event family (`subscription.created/updated/active`, `canceled`, `uncanceled`, `revoked`, `customer_seat.assigned/claimed/revoked`) applied with a `teamId` that has no row: no throw, no writes. This pins the "webhook no-op for deleted teams" follow-up (#3), which inspection shows already holds via the early returns; the tests make it load-bearing.

- [x] **Step 5: Run both suites, commit**

```bash
git add -A && git commit -m "test(teams): retry_after null branch, shared_at ordering, subscription mgmt, deleted-team no-ops"
```

---

### Task 12: Docs, changelog, version bump

**Files:**

- Modify: `apps/web/lib/changelog.ts` (`APP_VERSION` → `0.28.0`, new web entry), `apps/web/package.json` (`version`)
- Modify: `content/docs/teams.mdx` (invite section: any email, signup-links-invite path, note that email/password signup arrives with Plan C; today the invitee signs up via GitHub/Google with the invited address)
- Modify: `CLAUDE.md` (optional env table: `EMAIL_FROM` row)

- [x] **Step 1: Version + changelog.** Minor bump to 0.28.0 (new user-facing feature). Entry, track `web`: email invites to any address with signup linking, checkout idempotency, billing-webhook hardening, departed-member share cleanup. Housekeeping note from Plan A step 10 still stands: the parked instant-URL branch (PR #262) carries 0.26.0 and reconciles against whatever is on main when it merges.

- [x] **Step 2: Docs + CLAUDE.md.** Update the teams doc invite copy; add `EMAIL_FROM` to the optional env var table (with the `AGENT_EMAIL_FROM` fallback noted).

- [x] **Step 3: Full verification sweep**

```bash
pnpm typecheck && pnpm lint && pnpm --filter web build
cd apps/web && pnpm test:unit && npx vitest run tests/integration/
cd ../../apps/receiver-rs && cargo test   # must pass untouched; no receiver changes in this plan
```

- [x] **Step 4: Commit, push, open the PR**

```bash
git add -A && git commit -m "chore(release): v0.28.0, team email invites + Plan A follow-up hardening"
```

---

## Deploy checklist (after merge; operator steps, not tasks)

1. **Apply `00036_invite_linking.sql` to production** with the standard prefix (`SET lock_timeout='5s';`, `--set=ON_ERROR_STOP=1`, plain psql). The `add column` on `teams` takes a brief metadata-only ACCESS EXCLUSIVE lock; `teams` is not on the capture hot path's lock-sensitive spine the way `requests` was in Plan A, but the timeout habit stays. Replacing `handle_new_user` is safe at any time; signups during the same transaction just wait.
2. `NOTIFY pgrst, 'reload schema'` is in the migration file; verify it ran (per the prod deploy convention: migration → NOTIFY pgrst → deploy-web).
3. **Verify production email config**: `SMTP_HOST` (and/or `RESEND_API_KEY`) are already live for the agent-OTP flow; decide whether to set `EMAIL_FROM` or keep the `AGENT_EMAIL_FROM` fallback. No new secrets are required.
4. `make deploy-web`.
5. **Smoke test**: from a production team, invite an address with no account; confirm real email delivery, sign up with that address, confirm the invite is linked and pending, accept, confirm the member row + Polar seat. This overlaps with **Plan A's still-outstanding checklist step 8** (real checkout + cancel smoke test): doing both in one session on one throwaway team closes that item too.
6. **Watch the logs for the new guards** for a day or two: `[team-billing] ignoring event for foreign subscription` / `ignoring non-created event for unsubscribed team` firing on legitimate traffic would mean the guard conditions need loosening; firing on stale deliveries is them doing their job.

## Plan A deferred follow-ups: disposition

| Plan A follow-up | Disposition |
| --- | --- |
| #1 Personal Pro renewal usage-reset race | **Fixed here** (Task 6) |
| #2 Departed-member shares keep billing the pool | **Fixed here** (Task 9) |
| #3 Webhook no-op for deleted teams | Already holds by inspection; **pinned by tests** (Task 11) |
| #3 Pending-checkout tracking / double-checkout gap | **Fixed here** (Task 8: session reuse; extended post-review with an atomic per-team lease on `pending_checkout`: at most one concurrent request mints while the lease holds, losers reuse the winner's session or get `checkout_in_progress`, and follow-up writes are fenced on the lease token). Bounded, not absolute: a request stalled past the 60s lease TTL can still yield a second Polar session (Polar exposes no checkout idempotency key); Task 7's G1 guard and its error log remain the backstop if both complete. |
| #3 Alerting on seat/subscription revoke failure | **Stays log-based, by decision.** There is no alerting infrastructure; revoke failures `console.error` into journald, which the operator tails (`make prod`). Revisit if/when an alerting channel exists. |
| #4 `capture_webhook` ACL hardening | Shipped in Plan A (00035); nothing to do |
| #5 Live-subscription guard on `created`/`updated`/`active` | **Fixed here** (Task 7) |
| #6 Checkout 502 Polar detail, endpoint-switcher mismatch, team page `fetchData`, anon `42501` asserts | **Fixed here** (Task 10) |
| #6 T3/T5 coverage gaps (`retry_after` null, cancel/resubscribe/revoke, `shared_at` ordering) | **Fixed here** (Task 11) |
| Equal-`shared_at` tiebreaker determinism | **Out of scope, documented.** Requires re-issuing `capture_webhook` in a migration for a microsecond-collision case in which exactly one team is billed either way (never both, never neither). Not worth the churn risk on the hot-path procedure. |
