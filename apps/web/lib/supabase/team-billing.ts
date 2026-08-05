import { createPolarClient, getPolarTeamsCheckoutConfig, unwrapPolarResult } from "@/lib/polar";
import { createAdminClient } from "./admin";
import {
  asNonEmptyString,
  asRecord,
  normalizeStoredSubscriptionStatus,
  parseEventTimestamp,
} from "./billing-shared";
import type { Database } from "./database";

/** Pooled request allowance granted per seat, per 30-day period. */
export const TEAM_SEAT_REQUEST_LIMIT = 100_000;

const MAX_TEAM_SEATS = 1000;

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
>;

const BILLING_TEAM_COLUMNS =
  "id, name, created_by, polar_customer_id, polar_subscription_id, subscription_status, seats, cancel_at_period_end";

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

  const polar = createPolarClient();
  const result = await polar.customers.create({
    email: owner?.email ?? "",
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

async function countTeamMembers(teamId: string): Promise<number> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("team_members")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId);

  if (error) {
    throw error;
  }

  return count ?? 0;
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

  const memberCount = await countTeamMembers(teamId);
  if (seats < memberCount) {
    throw new TeamBillingError(
      "seats_below_members",
      `Team has ${memberCount} members — remove members before reducing to ${seats} seats`
    );
  }

  const polar = createPolarClient();
  const result = await polar.subscriptions.update({
    id: team.polar_subscription_id,
    subscriptionUpdate: { seats },
  });
  unwrapPolarResult(result, "team seat update");

  // Optimistic local write; the subscription.updated webhook confirms it.
  await updateTeamById(team.id, {
    seats,
    request_limit: seats * TEAM_SEAT_REQUEST_LIMIT,
  });
}

/** Cancels immediately. Used by team deletion, where the team row is already gone. */
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
  teamId: string,
  data: Record<string, unknown>
): Promise<void> {
  const admin = createAdminClient();
  const { data: team, error } = await admin
    .from("teams")
    .select("polar_subscription_id, seats")
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

  // subscription_status, request_limit and both period bounds are written in a
  // single statement on purpose: a team with a status but no request_limit
  // hard-429s every request, and one with a status but no period_end never
  // resets. They must never be observable apart.
  await updateTeamById(teamId, {
    polar_customer_id: customerId ?? undefined,
    polar_subscription_id: subscriptionId ?? undefined,
    subscription_status: normalizeStoredSubscriptionStatus(data.status),
    seats,
    request_limit: seats * TEAM_SEAT_REQUEST_LIMIT,
    period_start: parseEventTimestamp(data.currentPeriodStart),
    period_end: parseEventTimestamp(data.currentPeriodEnd),
    cancel_at_period_end:
      typeof data.cancelAtPeriodEnd === "boolean" ? data.cancelAtPeriodEnd : false,
    ...(isNewSubscription ? { requests_used: 0 } : {}),
  });
}

/**
 * Whether a cancel/uncancel event still describes the subscription the team
 * holds. Both events write a non-null `subscription_status`, which is the team's
 * access gate — so a retried `subscription.canceled` landing after
 * `subscription.revoked` would silently re-open a deactivated team's pool, and
 * neither reset CTE could ever clean it up (both require `period_end` non-null).
 * A `canceled` that arrives too early is safe to drop: the `created`/`updated`
 * event that follows carries `cancelAtPeriodEnd` and re-applies it.
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

  const { error } = await admin
    .from("team_members")
    .delete()
    .eq("team_id", teamId)
    .eq("user_id", memberUserId);

  if (error) {
    throw error;
  }
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
      await applyTeamSubscriptionState(teamId, data);
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
      // Nulling the status is what deactivates the team: capture_webhook and the
      // gating helpers key off it. seats/requests_used/request_limit are kept so
      // the period's usage stays visible until a new subscription resets it.
      await updateTeamById(teamId, {
        subscription_status: null,
        polar_subscription_id: null,
        cancel_at_period_end: false,
        period_start: null,
        period_end: null,
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
