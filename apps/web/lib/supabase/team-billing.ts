import { createPolarClient, getPolarTeamsCheckoutConfig, unwrapPolarResult } from "@/lib/polar";
import { createAdminClient } from "./admin";
import {
  asNonEmptyString,
  asRecord,
  normalizeStoredSubscriptionStatus,
  parseEventTimestamp,
} from "./billing-shared";
import type { Database } from "./database";
import { removeMemberShares } from "./teams-endpoints";

/** Pooled request allowance granted per seat, per 30-day period. */
export const TEAM_SEAT_REQUEST_LIMIT = 100_000;

const MAX_TEAM_SEATS = 1000;

/** How long a cached Polar checkout session is reused instead of minting a new one. */
const PENDING_CHECKOUT_TTL_MS = 30 * 60_000;

type TeamRow = Database["public"]["Tables"]["teams"]["Row"];
type TeamUpdate = Database["public"]["Tables"]["teams"]["Update"];

type BillingTeam = Pick<
  TeamRow,
  | "id"
  | "name"
  | "created_by"
  | "polar_customer_id"
  | "polar_subscription_id"
  | "subscription_status"
  | "seats"
  | "cancel_at_period_end"
  | "pending_checkout"
>;

const BILLING_TEAM_COLUMNS =
  "id, name, created_by, polar_customer_id, polar_subscription_id, subscription_status, seats, cancel_at_period_end, pending_checkout";

class TeamBillingError extends Error {
  code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "TeamBillingError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function updateTeamById(teamId: string, patch: TeamUpdate): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("teams").update(patch).eq("id", teamId);

  if (error) {
    throw error;
  }
}

async function getTeamForOwner(userId: string, teamId: string): Promise<BillingTeam> {
  const admin = createAdminClient();
  const { data: membership, error: memberError } = await admin
    .from("team_members")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .eq("role", "owner")
    .maybeSingle();

  if (memberError) {
    throw memberError;
  }

  if (!membership) {
    throw new TeamBillingError("not_owner", "Only the team owner can manage billing");
  }

  const { data: team, error } = await admin
    .from("teams")
    .select(BILLING_TEAM_COLUMNS)
    .eq("id", teamId)
    .maybeSingle<BillingTeam>();

  if (error) {
    throw error;
  }

  if (!team) {
    throw new TeamBillingError("team_not_found", "Team not found");
  }

  return team;
}

async function getTeamSubscriptionId(teamId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("teams")
    .select("polar_subscription_id")
    .eq("id", teamId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.polar_subscription_id ?? null;
}

async function ensureTeamPolarCustomerId(team: BillingTeam): Promise<string> {
  if (team.polar_customer_id) {
    return team.polar_customer_id;
  }

  const admin = createAdminClient();
  const { data: owner, error } = await admin
    .from("users")
    .select("email")
    .eq("id", team.created_by)
    .maybeSingle();

  if (error) {
    throw error;
  }

  // maybeSingle() returns null data without an error when no user row matches.
  // A Polar customer created with an empty email would bind the team to a
  // billing contact that can never receive seat or invoice emails.
  if (!owner?.email) {
    throw new TeamBillingError("owner_not_found", "Team owner has no billing email");
  }

  const polar = createPolarClient();
  const result = await polar.customers.create({
    email: owner.email,
    name: team.name,
    externalId: `team:${team.id}`,
    metadata: {
      teamId: team.id,
    },
  });
  const customer = unwrapPolarResult(result, "team customer creation");

  await updateTeamById(team.id, { polar_customer_id: customer.id });

  return customer.id;
}

function assertValidSeatCount(seats: number): void {
  if (!Number.isInteger(seats) || seats < 1 || seats > MAX_TEAM_SEATS) {
    throw new TeamBillingError("invalid_seats", `Seats must be between 1 and ${MAX_TEAM_SEATS}`);
  }
}

// ---------------------------------------------------------------------------
// Subscription management (owner-initiated)
// ---------------------------------------------------------------------------

export async function createTeamCheckout(
  userId: string,
  teamId: string,
  seats: number
): Promise<string> {
  assertValidSeatCount(seats);

  const team = await getTeamForOwner(userId, teamId);
  if (team.subscription_status !== null) {
    throw new TeamBillingError("already_subscribed", "Team already has an active subscription");
  }

  // Reuse the open checkout session when one was minted moments ago for the
  // same seat count: a double-click or second tab must not create a second
  // session that could ALSO be completed. Best-effort dedup only; the
  // foreign-subscription guard in applyTeamSubscriptionState is the backstop
  // if two sessions do complete. A different seat count mints a fresh session.
  const pending = asRecord(team.pending_checkout);
  const pendingUrl = pending ? asNonEmptyString(pending.url) : null;
  const pendingAtRaw = pending ? asNonEmptyString(pending.created_at) : null;
  const pendingAt = pendingAtRaw ? Date.parse(pendingAtRaw) : NaN;
  if (
    pendingUrl !== null &&
    typeof pending?.seats === "number" &&
    pending.seats === seats &&
    Number.isFinite(pendingAt) &&
    Date.now() - pendingAt < PENDING_CHECKOUT_TTL_MS
  ) {
    return pendingUrl;
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

  // Cache the session for the reuse path above. The session exists either way,
  // so a failed cache write only costs the dedup and must not fail the checkout.
  try {
    await updateTeamById(team.id, {
      pending_checkout: {
        id: checkout.id,
        url: checkout.url,
        seats,
        created_at: new Date().toISOString(),
      },
    });
  } catch (cacheError) {
    console.error("[team-billing] failed to cache pending checkout", { teamId, cacheError });
  }

  return checkout.url;
}

export async function cancelTeamSubscription(userId: string, teamId: string): Promise<void> {
  const team = await getTeamForOwner(userId, teamId);
  if (!team.polar_subscription_id) {
    throw new TeamBillingError("no_subscription", "No active subscription");
  }

  const polar = createPolarClient();
  const result = await polar.subscriptions.update({
    id: team.polar_subscription_id,
    subscriptionUpdate: {
      cancelAtPeriodEnd: true,
    },
  });
  unwrapPolarResult(result, "team subscription cancel");

  await updateTeamById(team.id, { cancel_at_period_end: true });
}

export async function resubscribeTeam(userId: string, teamId: string): Promise<void> {
  const team = await getTeamForOwner(userId, teamId);
  if (!team.polar_subscription_id) {
    throw new TeamBillingError("no_subscription", "No subscription to reactivate");
  }
  if (!team.cancel_at_period_end) {
    throw new TeamBillingError("not_scheduled", "Subscription is not scheduled for cancellation");
  }

  const polar = createPolarClient();
  const result = await polar.subscriptions.update({
    id: team.polar_subscription_id,
    subscriptionUpdate: {
      cancelAtPeriodEnd: false,
    },
  });
  unwrapPolarResult(result, "team subscription reactivate");

  await updateTeamById(team.id, { cancel_at_period_end: false });
}

export async function updateTeamSeats(
  userId: string,
  teamId: string,
  seats: number
): Promise<void> {
  assertValidSeatCount(seats);

  const team = await getTeamForOwner(userId, teamId);
  if (!team.polar_subscription_id) {
    throw new TeamBillingError("no_subscription", "No active subscription");
  }

  // Ordering is direction-specific. An increase tells Polar first: writing the
  // higher limit to the database before Polar confirms would expose capacity a
  // concurrent invite accept can fill, and a Polar rejection then leaves the
  // team above its paid seat count with a rollback that fails on
  // below_members. A reduction writes the database first, through an RPC that
  // takes the same row lock as accept_team_invite and re-counts members under
  // it; checking the count out here and lowering seats only after Polar
  // returned would leave a window where a concurrent invite accept admits a
  // member onto a seat this reduction is removing.
  const admin = createAdminClient();

  if (seats > team.seats) {
    const polar = createPolarClient();
    const result = await polar.subscriptions.update({
      id: team.polar_subscription_id,
      subscriptionUpdate: { seats },
    });
    unwrapPolarResult(result, "team seat update");

    const { data, error } = await admin.rpc("update_team_seats", {
      p_team_id: teamId,
      p_seats: seats,
    });
    const status = asRecord(data) ? asNonEmptyString(asRecord(data)!.status) : null;

    if (error || status !== "ok") {
      // Polar already accepted the increase, so the paid capacity exists but
      // the pool still shows the old limit. The subscription.updated webhook
      // reconciles seats and request_limit; surface the failure to the owner.
      console.error("[team-billing] Polar accepted seat increase but DB write failed", {
        teamId,
        seats,
        error,
        status,
      });
      if (error) {
        throw error;
      }
      throw new TeamBillingError("seat_update_failed", "Failed to update seats");
    }

    return;
  }

  const { data, error } = await admin.rpc("update_team_seats", {
    p_team_id: teamId,
    p_seats: seats,
  });

  if (error) {
    throw error;
  }

  const rpcResult = asRecord(data);
  const status = rpcResult ? asNonEmptyString(rpcResult.status) : null;

  if (status === "below_members") {
    const memberCount =
      typeof rpcResult?.member_count === "number" ? rpcResult.member_count : seats;
    throw new TeamBillingError(
      "seats_below_members",
      `Team has ${memberCount} members — remove members before reducing to ${seats} seats`
    );
  }

  if (status !== "ok") {
    throw new TeamBillingError("seat_update_failed", "Failed to update seats");
  }

  const previousSeats =
    typeof rpcResult?.previous_seats === "number" ? rpcResult.previous_seats : team.seats;

  try {
    const polar = createPolarClient();
    const result = await polar.subscriptions.update({
      id: team.polar_subscription_id,
      subscriptionUpdate: { seats },
    });
    unwrapPolarResult(result, "team seat update");
  } catch (polarError) {
    // Polar never saw the change, so put the previous count back (the same RPC,
    // so the restore also serializes against invite accepts). If the restore
    // itself is refused or fails, the subscription.updated webhook remains the
    // reconciler of record; surface the original Polar error either way.
    const { data: restoreData, error: restoreError } = await admin.rpc("update_team_seats", {
      p_team_id: teamId,
      p_seats: previousSeats,
    });

    const restoreStatus = asRecord(restoreData)
      ? asNonEmptyString(asRecord(restoreData)!.status)
      : null;
    if (restoreError || restoreStatus !== "ok") {
      console.error("[team-billing] failed to restore seats after Polar error", {
        teamId,
        previousSeats,
        restoreError,
        restoreStatus,
      });
    }

    throw polarError;
  }
}

/** Cancels immediately. Used by team deletion, which revokes before deleting the row. */
export async function revokeTeamSubscription(polarSubscriptionId: string): Promise<void> {
  const polar = createPolarClient();
  const result = await polar.subscriptions.revoke({ id: polarSubscriptionId });
  unwrapPolarResult(result, "team subscription revoke");
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/**
 * Assigns a Polar seat to `email`. Returns the seat id, or null when the team
 * has no subscription (unsubscribed teams seat nobody — the DB gates access).
 */
export async function assignTeamSeat(
  teamId: string,
  email: string,
  memberUserId: string
): Promise<string | null> {
  const subscriptionId = await getTeamSubscriptionId(teamId);
  if (!subscriptionId) {
    return null;
  }

  const polar = createPolarClient();
  const result = await polar.customerSeats.assignSeat({
    subscriptionId,
    email,
    // Defaults to false, which makes Polar email an invitation. Membership is
    // granted by our own invite flow, so claim the seat immediately instead.
    immediateClaim: true,
    metadata: {
      userId: memberUserId,
      teamId,
    },
  });
  const seat = unwrapPolarResult(result, "team seat assign");

  return asNonEmptyString(seat.id);
}

/**
 * Releases a Polar seat. Failures are logged and swallowed: the caller has
 * already removed the membership, and our DB — not Polar — gates team access.
 */
export async function revokeTeamSeat(
  teamId: string,
  seatId: string | null,
  email: string
): Promise<void> {
  try {
    const subscriptionId = await getTeamSubscriptionId(teamId);
    if (!subscriptionId) {
      return;
    }

    const polar = createPolarClient();
    let targetSeatId = seatId;

    if (!targetSeatId) {
      const listResult = await polar.customerSeats.listSeats({ subscriptionId });
      const list = unwrapPolarResult(listResult, "team seat list");
      const wanted = email.toLowerCase();
      const match = list.seats.find(
        (seat) =>
          seat.status !== "revoked" &&
          (seat.customerEmail?.toLowerCase() === wanted || seat.email?.toLowerCase() === wanted)
      );
      targetSeatId = match?.id ?? null;
    }

    if (!targetSeatId) {
      return;
    }

    const revokeResult = await polar.customerSeats.revokeSeat({ seatId: targetSeatId });
    unwrapPolarResult(revokeResult, "team seat revoke");
  } catch (error) {
    console.error("[team-billing] failed to revoke Polar seat", { teamId, seatId, error });
  }
}

// ---------------------------------------------------------------------------
// Webhook apply
// ---------------------------------------------------------------------------

/**
 * Team id carried by a Polar webhook payload, or null for personal events.
 *
 * Subscription/customer events carry it on the customer (metadata, or the
 * `team:<id>` external id we set at customer creation). Seat events carry a
 * bare `CustomerSeat` with no customer object, so the seat metadata we attach
 * in `assignTeamSeat` is the only routing signal available there.
 */
export function extractTeamIdFromWebhook(data: Record<string, unknown>): string | null {
  const customer = asRecord(data.customer);
  if (customer) {
    const metadata = asRecord(customer.metadata);
    const metadataTeamId = metadata ? asNonEmptyString(metadata.teamId) : null;
    if (metadataTeamId) {
      return metadataTeamId;
    }

    const externalId = asNonEmptyString(customer.externalId);
    if (externalId?.startsWith("team:")) {
      return asNonEmptyString(externalId.slice("team:".length));
    }
  }

  const seatMetadata = asRecord(data.seatMetadata) ?? asRecord(data.metadata);
  return seatMetadata ? asNonEmptyString(seatMetadata.teamId) : null;
}

function extractSeatUserId(data: Record<string, unknown>): string | null {
  const metadata = asRecord(data.seatMetadata) ?? asRecord(data.metadata);
  return metadata ? asNonEmptyString(metadata.userId) : null;
}

function extractSeatEmail(data: Record<string, unknown>): string | null {
  return asNonEmptyString(data.customerEmail) ?? asNonEmptyString(data.email);
}

async function findUserIdByEmail(email: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle<{ id: string }>();

  if (error) {
    throw error;
  }

  return data?.id ?? null;
}

/** The team member a seat event refers to: metadata user id first, email second. */
async function resolveSeatMemberId(data: Record<string, unknown>): Promise<string | null> {
  const metadataUserId = extractSeatUserId(data);
  if (metadataUserId) {
    return metadataUserId;
  }

  const email = extractSeatEmail(data);
  if (!email) {
    return null;
  }

  return findUserIdByEmail(email);
}

async function applyTeamSubscriptionState(
  eventType: string,
  teamId: string,
  data: Record<string, unknown>
): Promise<void> {
  const admin = createAdminClient();
  const { data: team, error } = await admin
    .from("teams")
    .select("polar_subscription_id, subscription_status, seats, period_start")
    .eq("id", teamId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!team) {
    return;
  }

  const subscriptionId = asNonEmptyString(data.id);
  const customerId = asNonEmptyString(data.customerId);

  // The team already tracks a live subscription and this event describes a
  // different one. Applying it would let a stale cross-subscription event (or
  // a double-checkout's second subscription) overwrite the row that gates
  // access and billing. The Polar-side orphan is deliberately NOT auto-revoked;
  // this log line is the remediation signal.
  if (
    team.polar_subscription_id !== null &&
    team.subscription_status !== null &&
    subscriptionId !== null &&
    subscriptionId !== team.polar_subscription_id
  ) {
    console.error("[team-billing] ignoring event for foreign subscription", {
      teamId,
      eventType,
      storedSubscriptionId: team.polar_subscription_id,
      eventSubscriptionId: subscriptionId,
    });
    return;
  }

  // A deactivated team (revoke nulls both the status and the stored id) may
  // only be reactivated by subscription.created, i.e. a genuinely new
  // subscription. A delayed `updated`/`active` for the revoked subscription
  // would otherwise re-open the pool with bounds the cron then renews
  // unbilled. Trade-off: if Polar never delivers `created` for a new
  // subscription, the team stays visibly inactive (activation-wait timeout on
  // the team page) until redelivery, a loud failure instead of a silent
  // unbilled reactivation. Mixed states (one of id/status set, the other not)
  // fall through: they only arise from manual intervention, and the full-state
  // upsert below is the correct repair.
  if (
    team.polar_subscription_id === null &&
    team.subscription_status === null &&
    eventType !== "subscription.created"
  ) {
    console.warn("[team-billing] ignoring non-created event for unsubscribed team", {
      teamId,
      eventType,
      eventSubscriptionId: subscriptionId,
    });
    return;
  }
  const payloadSeats =
    typeof data.seats === "number" && Number.isInteger(data.seats) && data.seats > 0
      ? data.seats
      : null;
  // `Subscription.seats` is null for non-seat-based products. Falling back to a
  // fresh team's stored 0 would activate it with request_limit 0, which 429s
  // every request the team is paying for — floor the pool at one seat instead.
  const seats = payloadSeats ?? (team.seats > 0 ? team.seats : 1);

  // A different subscription id means a brand-new subscription (the team was
  // deactivated and re-subscribed) — that starts a fresh pooled quota. Repeat
  // events for the same subscription must never clear usage.
  const isNewSubscription =
    subscriptionId !== null && subscriptionId !== team.polar_subscription_id;

  const incomingPeriodStart = parseEventTimestamp(data.currentPeriodStart);
  const incomingPeriodStartMs = incomingPeriodStart ? Date.parse(incomingPeriodStart) : null;
  const storedPeriodStartMs = team.period_start ? Date.parse(team.period_start) : null;

  // An ordinary renewal keeps the subscription id and only advances the period
  // bounds, so a forward-moving period start is the one signal that a fresh
  // paid month began. It must clear usage here: this same write pushes
  // period_end into the future, which blinds the cron fallback reset. Seat-only
  // updates carry the unchanged period start and keep usage.
  const isRenewal =
    !isNewSubscription &&
    incomingPeriodStartMs !== null &&
    storedPeriodStartMs !== null &&
    incomingPeriodStartMs > storedPeriodStartMs;

  // A period start older than the stored one is a stale, out-of-order event
  // (a retried `updated` landing after the renewal already applied). Writing
  // its bounds would roll the period backwards, so keep the stored bounds.
  const isStalePeriod =
    !isNewSubscription &&
    incomingPeriodStartMs !== null &&
    storedPeriodStartMs !== null &&
    incomingPeriodStartMs < storedPeriodStartMs;

  // created/updated/active all describe a live subscription, and for teams a
  // null subscription_status IS the deactivation gate (capture_webhook stops
  // billing the pool, accept_team_invite refuses, the dashboard shows
  // suspended). An unrecognized status value must therefore never null the
  // gate: keep the stored status, or default to active for a first event.
  const status =
    normalizeStoredSubscriptionStatus(data.status) ?? team.subscription_status ?? "active";

  // subscription_status, request_limit and both period bounds are written in a
  // single statement on purpose: a team with a status but no request_limit
  // hard-429s every request, and one with a status but no period_end never
  // resets. They must never be observable apart.
  await updateTeamById(teamId, {
    polar_customer_id: customerId ?? undefined,
    polar_subscription_id: subscriptionId ?? undefined,
    subscription_status: status,
    seats,
    request_limit: seats * TEAM_SEAT_REQUEST_LIMIT,
    period_start: isStalePeriod ? undefined : incomingPeriodStart,
    period_end: isStalePeriod ? undefined : parseEventTimestamp(data.currentPeriodEnd),
    cancel_at_period_end:
      typeof data.cancelAtPeriodEnd === "boolean" ? data.cancelAtPeriodEnd : false,
    // The checkout that produced this subscription is no longer pending.
    pending_checkout: null,
    ...(isNewSubscription || isRenewal ? { requests_used: 0 } : {}),
  });
}

/**
 * Whether a cancel/uncancel/revoke event still describes the subscription the
 * team holds. Cancel and uncancel write a non-null `subscription_status`, which
 * is the team's access gate — so a retried `subscription.canceled` landing after
 * `subscription.revoked` would silently re-open a deactivated team's pool, and
 * neither reset CTE could ever clean it up (both require `period_end` non-null).
 * A `canceled` that arrives too early is safe to drop: the `created`/`updated`
 * event that follows carries `cancelAtPeriodEnd` and re-applies it.
 *
 * Revocation needs the same check in the other direction: after a team replaces
 * its subscription, a delayed or retried `subscription.revoked` for the old one
 * must not clear the row that now tracks the new, paying subscription.
 */
async function isLiveSubscriptionEvent(
  teamId: string,
  data: Record<string, unknown>
): Promise<boolean> {
  const storedSubscriptionId = await getTeamSubscriptionId(teamId);
  if (!storedSubscriptionId) {
    return false;
  }

  const eventSubscriptionId = asNonEmptyString(data.id);
  return eventSubscriptionId === null || eventSubscriptionId === storedSubscriptionId;
}

async function applySeatAssignment(teamId: string, data: Record<string, unknown>): Promise<void> {
  const seatId = asNonEmptyString(data.id);
  if (!seatId) {
    return;
  }

  const memberUserId = await resolveSeatMemberId(data);
  if (!memberUserId) {
    return;
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("team_members")
    .update({ polar_seat_id: seatId })
    .eq("team_id", teamId)
    .eq("user_id", memberUserId)
    .is("polar_seat_id", null);

  if (error) {
    throw error;
  }
}

async function applySeatRevocation(teamId: string, data: Record<string, unknown>): Promise<void> {
  const memberUserId = await resolveSeatMemberId(data);
  if (!memberUserId) {
    return;
  }

  const admin = createAdminClient();
  const { data: team, error: teamError } = await admin
    .from("teams")
    .select("created_by")
    .eq("id", teamId)
    .maybeSingle();

  if (teamError) {
    throw teamError;
  }

  // The owner keeps access even if their seat is released — otherwise a stray
  // Polar event could orphan the team.
  if (!team || team.created_by === memberUserId) {
    return;
  }

  const { data: membership, error: membershipError } = await admin
    .from("team_members")
    .select("polar_seat_id")
    .eq("team_id", teamId)
    .eq("user_id", memberUserId)
    .maybeSingle();

  if (membershipError) {
    throw membershipError;
  }

  if (!membership) {
    return;
  }

  // Honor the revocation only for the seat the member currently holds: a
  // delayed event for an old seat must not remove a member who has since been
  // re-seated. A null stored id (the claim webhook has not landed yet) still
  // honors the revoke, matching the pre-seat-id behavior.
  const eventSeatId = asNonEmptyString(data.id);
  if (eventSeatId && membership.polar_seat_id && membership.polar_seat_id !== eventSeatId) {
    return;
  }

  const { error } = await admin
    .from("team_members")
    .delete()
    .eq("team_id", teamId)
    .eq("user_id", memberUserId);

  if (error) {
    throw error;
  }

  // The webhook-driven removal cleans up like remove/leave do: the departed
  // member's shares must stop billing the team pool.
  await removeMemberShares(teamId, memberUserId);
}

export async function applyTeamPolarWebhookEvent(
  eventType: string,
  teamId: string,
  data: Record<string, unknown>
): Promise<void> {
  switch (eventType) {
    case "customer.created":
    case "customer.updated":
    case "customer.deleted":
    case "customer.state_changed":
    case "order.paid":
    case "order.updated":
    case "order.refunded":
      return;

    case "subscription.created":
    case "subscription.updated":
    case "subscription.active":
      await applyTeamSubscriptionState(eventType, teamId, data);
      return;

    case "subscription.canceled":
      if (!(await isLiveSubscriptionEvent(teamId, data))) {
        return;
      }

      await updateTeamById(teamId, {
        cancel_at_period_end: true,
        subscription_status: "canceled",
      });
      return;

    case "subscription.uncanceled":
      if (!(await isLiveSubscriptionEvent(teamId, data))) {
        return;
      }

      await updateTeamById(teamId, {
        cancel_at_period_end: false,
        subscription_status: normalizeStoredSubscriptionStatus(data.status) ?? "active",
      });
      return;

    case "subscription.revoked":
      if (!(await isLiveSubscriptionEvent(teamId, data))) {
        return;
      }

      // Nulling the status is what deactivates the team: capture_webhook and the
      // gating helpers key off it. seats/requests_used/request_limit are kept so
      // the period's usage stays visible until a new subscription resets it.
      await updateTeamById(teamId, {
        subscription_status: null,
        polar_subscription_id: null,
        cancel_at_period_end: false,
        period_start: null,
        period_end: null,
        // A pre-revoke checkout session must not be resurrected by the reuse
        // path after a resubscribe.
        pending_checkout: null,
      });
      return;

    case "customer_seat.assigned":
    case "customer_seat.claimed":
      await applySeatAssignment(teamId, data);
      return;

    case "customer_seat.revoked":
      await applySeatRevocation(teamId, data);
      return;

    default:
      return;
  }
}

export { TeamBillingError };
