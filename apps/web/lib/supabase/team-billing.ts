import {
  createPolarClient,
  getPolarTeamsCheckoutConfig,
  loggablePolarError,
  polarErrorCode,
  teamPlanForProduct,
  teamPlanProductId,
  type BillingInterval,
  type TeamPlan,
} from "@/lib/polar";
import { returnOrigin } from "@/lib/site-server";
import { errors } from "@polar-sh/sdk/2026-10";
import { ENTITLEMENTS, teamRequestLimit } from "@/lib/entitlements";
import {
  creditBalanceFromOrders,
  quotePlanChange,
  quoteSeatChange,
  type PlanChangeQuote,
  type SeatChangeQuote,
} from "@/lib/team-pricing";
import { createAdminClient } from "./admin";
import { addMonthUtc, remainingShare } from "./billing";
import {
  asNonEmptyString,
  asRecord,
  normalizeStoredSubscriptionStatus,
  parseEventTimestamp,
} from "./billing-shared";
import type { Database } from "./database";
import { removeMemberShares } from "./teams-endpoints";
import { reportError } from "@/lib/observability";

/** Pooled request allowance granted per Teams seat, per period. */
export const TEAM_SEAT_REQUEST_LIMIT = ENTITLEMENTS.team.requestLimit;

/**
 * Both team plans start at two seats: Polar's Team Business products refuse
 * fewer, and Teams follows so an upgrade is always one product switch.
 * Teams subscribed before the minimum may keep one seat until they change it.
 */
export const MIN_TEAM_SEATS = 2;
const MAX_TEAM_SEATS = 1000;

/** How long a cached Polar checkout session is reused instead of minting a new one. */
const PENDING_CHECKOUT_TTL_MS = 30 * 60_000;

/**
 * How long a "creating" lease blocks other requests from minting. Polar
 * checkout creation takes single-digit seconds; a lease older than this is an
 * abandoned attempt (crashed request) and may be claimed over.
 */
const CHECKOUT_LEASE_TTL_MS = 60_000;

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
  | "pending_seats"
  | "business"
  | "billing_interval"
  | "pending_plan"
  | "pending_interval"
>;

const BILLING_TEAM_COLUMNS =
  "id, name, created_by, polar_customer_id, polar_subscription_id, subscription_status, seats, cancel_at_period_end, pending_checkout, pending_seats, business, billing_interval, pending_plan, pending_interval";

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

export async function getTeamForOwner(userId: string, teamId: string): Promise<BillingTeam> {
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

export async function ensureTeamPolarCustomerId(team: BillingTeam): Promise<string> {
  if (team.polar_customer_id) {
    return team.polar_customer_id;
  }

  const admin = createAdminClient();
  const { data: owner, error } = await admin
    .from("users")
    .select("email, name")
    .eq("id", team.created_by)
    .maybeSingle();

  if (error) {
    throw error;
  }

  // maybeSingle() returns null data without an error when no user row matches.
  // A team customer whose owner member has no email would bind the team to a
  // billing contact that can never receive seat or invoice emails.
  if (!owner?.email) {
    throw new TeamBillingError("owner_not_found", "Team owner has no billing email");
  }

  // Polar allows one customer per email per organization, and the owner very
  // likely already is one (a personal Pro customer) or owns another team. So
  // the team customer is a `team`-type customer with no email of its own; the
  // owner is attached as its owner member instead. Polar prefills checkout,
  // receipts, and customer-portal sign-in from the owner member's email, and
  // member emails are only unique within a customer, so the same person can
  // own any number of teams and still hold a personal customer. The team's
  // own identity stays on `external_id` for webhook routing.
  const polar = createPolarClient();
  const customer = await polar.customers.create({
    type: "team",
    name: team.name,
    external_id: `team:${team.id}`,
    metadata: {
      teamId: team.id,
    },
    owner: {
      email: owner.email,
      name: owner.name ?? undefined,
      external_id: team.created_by,
    },
  });

  await updateTeamById(team.id, { polar_customer_id: customer.id });

  return customer.id;
}

/**
 * A seat count the team may move to: 2 to 1,000, or the count it has (a team
 * subscribed with one seat before the minimum keeps it, and asking for it
 * cancels a scheduled reduction).
 */
function assertValidSeatCount(seats: number, currentSeats: number | null = null): void {
  if (!Number.isInteger(seats) || seats > MAX_TEAM_SEATS || seats < 1) {
    throw new TeamBillingError(
      "invalid_seats",
      `Seats must be between ${MIN_TEAM_SEATS} and ${MAX_TEAM_SEATS}`
    );
  }
  if (seats < MIN_TEAM_SEATS && seats !== currentSeats) {
    throw new TeamBillingError("invalid_seats", `A team needs at least ${MIN_TEAM_SEATS} seats`);
  }
}

/** The plan a team is on, from its stored state. */
function storedTeamPlan(team: Pick<BillingTeam, "business" | "billing_interval">): {
  plan: TeamPlan;
  interval: BillingInterval;
} {
  return {
    plan: team.business ? "team_business" : "team",
    interval: team.billing_interval === "year" ? "year" : "month",
  };
}

/** Plans by rank, and whether a change is an upgrade Polar charges for at once. */
function isUpgrade(
  from: { plan: TeamPlan; interval: BillingInterval },
  to: { plan: TeamPlan; interval: BillingInterval }
): boolean {
  if (from.plan !== to.plan) return to.plan === "team_business";
  return from.interval === "month" && to.interval === "year";
}

/** The product of a team plan, or the error the owner sees when it is not offered. */
function requireTeamPlanProduct(plan: TeamPlan, interval: BillingInterval): string {
  const productId = teamPlanProductId(plan, interval);
  if (!productId) {
    throw new TeamBillingError("not_offered", "That plan is not available");
  }
  return productId;
}

// ---------------------------------------------------------------------------
// Subscription management (owner-initiated)
// ---------------------------------------------------------------------------

/**
 * The cached Polar session's URL when it is reusable for this seat count, else
 * null. Polar's own session expiry is authoritative when stored; the 30-minute
 * TTL on created_at is the fallback for caches without one. A "creating" lease
 * (no url yet) is never reusable.
 */
function reusablePendingCheckoutUrl(
  pendingCheckout: unknown,
  seats: number,
  productId: string
): string | null {
  const pending = asRecord(pendingCheckout);
  const url = pending ? asNonEmptyString(pending.url) : null;
  if (url === null || typeof pending?.seats !== "number" || pending.seats !== seats) {
    return null;
  }
  // A session for another plan (or one cached before plans were stored) is not reused.
  if (pending.product !== productId) {
    return null;
  }

  const createdAtRaw = asNonEmptyString(pending.created_at);
  const createdAt = createdAtRaw ? Date.parse(createdAtRaw) : NaN;
  const expiresAtRaw = asNonEmptyString(pending.expires_at);
  const expiresAt = expiresAtRaw ? Date.parse(expiresAtRaw) : NaN;
  const sessionStillOpen = Number.isFinite(expiresAt)
    ? Date.now() < expiresAt
    : Number.isFinite(createdAt) && Date.now() - createdAt < PENDING_CHECKOUT_TTL_MS;

  return sessionStillOpen ? url : null;
}

/**
 * Atomically claims the right to mint a Polar checkout session for a team by
 * writing a "creating" lease into `pending_checkout`. The claim succeeds when
 * the slot is empty, holds an abandoned lease (older than the lease TTL), an
 * expired session, or a session for a different seat count — exactly the
 * states `createTeamCheckout` would mint over. Concurrent requests race this
 * single conditional UPDATE, so at most one of them mints while the lease
 * holds; the losers reuse the winner's session or report checkout_in_progress.
 *
 * Returns the lease token (the lease's created_at) on success, else null. The
 * holder's follow-up writes are fenced on the token (see
 * `releasePendingCheckoutLease`). Bounded guarantee, not absolute: a request
 * stalled past the lease TTL loses the slot and a new claimant can mint a
 * second session — Polar exposes no idempotency key for checkouts — with the
 * foreign-subscription guard in applyTeamSubscriptionState as the backstop if
 * both are completed.
 *
 * Exported for the integration test that pins the PostgREST filter syntax.
 */
export async function claimPendingCheckoutSlot(
  teamId: string,
  seats: number,
  productId: string
): Promise<string | null> {
  const admin = createAdminClient();
  const now = Date.now();
  const leaseCutoff = new Date(now - CHECKOUT_LEASE_TTL_MS).toISOString();
  const nowIso = new Date(now).toISOString();

  const { data, error } = await admin
    .from("teams")
    .update({
      pending_checkout: { status: "creating", seats, product: productId, created_at: nowIso },
    })
    .eq("id", teamId)
    .or(
      [
        "pending_checkout.is.null",
        `pending_checkout->>created_at.lt."${leaseCutoff}"`,
        `pending_checkout->>seats.neq.${seats}`,
        "pending_checkout->>product.is.null",
        `pending_checkout->>product.neq."${productId}"`,
        `pending_checkout->>expires_at.lt."${nowIso}"`,
      ].join(",")
    )
    .select("id")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data !== null ? nowIso : null;
}

/**
 * Writes `pending_checkout` only while the caller's lease (identified by its
 * created_at token) is still in place. A request stalled past the lease TTL
 * loses the slot to a new claimant; its follow-up writes must then no-op
 * instead of overwriting the newer session, or nulling it (which would invite
 * a third one).
 */
async function writePendingCheckoutIfLeaseHeld(
  teamId: string,
  leaseToken: string,
  value: TeamUpdate["pending_checkout"]
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("teams")
    .update({ pending_checkout: value })
    .eq("id", teamId)
    .eq("pending_checkout->>created_at", leaseToken);

  if (error) {
    throw error;
  }
}

/**
 * Releases a checkout lease, fenced on the lease token. Exported for the
 * integration test that pins the PostgREST jsonb-path filter syntax.
 */
export async function releasePendingCheckoutLease(
  teamId: string,
  leaseToken: string
): Promise<void> {
  await writePendingCheckoutIfLeaseHeld(teamId, leaseToken, null);
}

export async function createTeamCheckout(
  userId: string,
  teamId: string,
  seats: number,
  plan: TeamPlan = "team",
  interval: BillingInterval = "month"
): Promise<string> {
  assertValidSeatCount(seats);
  const productId = requireTeamPlanProduct(plan, interval);

  const team = await getTeamForOwner(userId, teamId);
  if (team.subscription_status !== null) {
    throw new TeamBillingError("already_subscribed", "Team already has an active subscription");
  }

  // Reuse the open checkout session for the same plan and seat count: a
  // double-click or second tab must not create a second session that could
  // ALSO be completed.
  const cachedUrl = reusablePendingCheckoutUrl(team.pending_checkout, seats, productId);
  if (cachedUrl !== null) {
    return cachedUrl;
  }

  // Serialize minting: exactly one concurrent request wins the lease and
  // creates the Polar session. The foreign-subscription guard in
  // applyTeamSubscriptionState remains the backstop for sessions minted
  // before this lease existed (or across a lease expiry).
  const leaseToken = await claimPendingCheckoutSlot(teamId, seats, productId);
  if (leaseToken === null) {
    // Another request holds the slot. One re-read settles whether it already
    // finished (reuse its session) or is still minting (tell the caller to
    // retry in a moment rather than minting a double).
    const admin = createAdminClient();
    const { data: fresh, error } = await admin
      .from("teams")
      .select("pending_checkout")
      .eq("id", teamId)
      .maybeSingle();

    if (error) throw error;

    const freshUrl = reusablePendingCheckoutUrl(fresh?.pending_checkout ?? null, seats, productId);
    if (freshUrl !== null) {
      return freshUrl;
    }

    throw new TeamBillingError(
      "checkout_in_progress",
      "A checkout session is already being prepared for this team — try again in a moment"
    );
  }

  try {
    const polar = createPolarClient();
    const { appUrl } = getPolarTeamsCheckoutConfig();
    const customerId = await ensureTeamPolarCustomerId(team);

    const checkout = await polar.checkouts.create({
      products: [productId],
      seats,
      success_url: `${await returnOrigin(appUrl)}/teams/${teamId}?subscribed=true`,
      customer_id: customerId,
    });

    // Replace the lease with the session for the reuse path, fenced on the
    // lease token: a request stalled past the lease TTL must not overwrite a
    // newer claimant's session. The session exists either way, so a failed
    // cache write only costs the dedup (the lease TTL then reopens the slot)
    // and must not fail the checkout.
    try {
      await writePendingCheckoutIfLeaseHeld(team.id, leaseToken, {
        id: checkout.id,
        url: checkout.url,
        seats,
        product: productId,
        created_at: new Date().toISOString(),
        expires_at: parseEventTimestamp(checkout.expires_at),
      });
    } catch (cacheError) {
      reportError("[team-billing] failed to cache pending checkout", cacheError, { teamId });
    }

    return checkout.url;
  } catch (error) {
    // Release the lease (token-fenced) so a retry can mint immediately
    // instead of waiting out the lease TTL. Best effort: the TTL is the
    // backstop.
    try {
      await releasePendingCheckoutLease(team.id, leaseToken);
    } catch (releaseError) {
      reportError("[team-billing] failed to release checkout lease", releaseError, { teamId });
    }
    throw error;
  }
}

export async function cancelTeamSubscription(userId: string, teamId: string): Promise<void> {
  const team = await getTeamForOwner(userId, teamId);
  if (!team.polar_subscription_id) {
    throw new TeamBillingError("no_subscription", "No active subscription");
  }

  const polar = createPolarClient();
  await polar.subscriptions.update(team.polar_subscription_id, { cancel_at_period_end: true });

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
  await polar.subscriptions.update(team.polar_subscription_id, { cancel_at_period_end: false });

  await updateTeamById(team.id, { cancel_at_period_end: false });
}

export async function updateTeamSeats(
  userId: string,
  teamId: string,
  seats: number
): Promise<void> {
  const team = await getTeamForOwner(userId, teamId);
  assertValidSeatCount(seats, team.seats);
  if (!team.polar_subscription_id) {
    throw new TeamBillingError("no_subscription", "No active subscription");
  }

  // Increases are charged now and raise capacity now. Reductions take effect
  // at the next renewal: the paid seats, member cap and request pool stay until
  // then, and Polar records the change as the subscription's pending update.
  //
  // Ordering is direction-specific. An increase tells Polar first: writing the
  // higher limit to the database before Polar confirms would expose capacity a
  // concurrent invite accept can fill. A reduction is recorded in the database
  // first, through an RPC that takes the same row lock as accept_team_invite
  // and re-counts members under it, so no accept can admit a member the
  // renewal would have no seat for.
  const admin = createAdminClient();

  if (seats > team.seats) {
    // "invoice" charges the prorated price of the added seats right away,
    // together with any earlier change still waiting for the next invoice.
    // Under the organization default ("prorate") the charge waited for the
    // renewal and was never collected if the subscription ended first. A
    // declined charge leaves the Polar subscription unchanged, so the database
    // write below is skipped too.
    const polar = createPolarClient();
    let increased: Record<string, unknown>;
    let increasedAt: Date;
    try {
      increased = (await polar.subscriptions.update(team.polar_subscription_id, {
        seats,
        proration_behavior: "invoice",
      })) as unknown as Record<string, unknown>;
      increasedAt = new Date();
    } catch (error) {
      const declined = declinedCharge(error, "no seats were added");
      if (declined) throw declined;
      throw error;
    }

    const { data, error } = await admin.rpc("update_team_seats", {
      p_team_id: teamId,
      p_seats: seats,
    });
    const status = asRecord(data) ? asNonEmptyString(asRecord(data)!.status) : null;

    if (error || status !== "ok") {
      // Polar already accepted the increase, so the paid capacity exists but
      // the pool still shows the old limit. The subscription.updated webhook
      // reconciles seats and request_limit; surface the failure to the owner.
      reportError("[team-billing] Polar accepted seat increase but DB write failed", error, {
        teamId,
        seats,
        status,
      });
      if (error) {
        throw error;
      }
      throw new TeamBillingError("seat_update_failed", "Failed to update seats");
    }

    // Adding seats drops any pending reduction in Polar (update_team_seats
    // already cleared the row) but keeps a pending plan change; record
    // Polar's state with the time it was confirmed, so an older read cannot
    // bring the dropped schedule back.
    try {
      await syncPendingUpdate(teamId, team.polar_subscription_id, increased, increasedAt);
    } catch (syncError) {
      reportError("[team-billing] failed to record the seat schedule from Polar", syncError, {
        teamId,
      });
    }

    return;
  }

  if (seats === team.seats && team.pending_seats === null) {
    return;
  }

  // A reduction, or `seats === team.seats` with a reduction pending, which
  // cancels it. Polar treats both the same way: "next_period" with the current
  // count clears the pending update.
  const { data, error } = await admin.rpc("schedule_team_seat_reduction", {
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
      `Team has ${memberCount} members, so it needs at least ${memberCount} seats. Remove members first.`
    );
  }

  if (status !== "ok") {
    throw new TeamBillingError("seat_update_failed", "Failed to update seats");
  }

  const previousPending =
    typeof rpcResult?.previous_pending_seats === "number" ? rpcResult.previous_pending_seats : null;
  // What the RPC stored: the current count clears the schedule.
  const recordedPending = seats === team.seats ? null : seats;

  let updated: Record<string, unknown>;
  let updatedAt: Date;
  try {
    const polar = createPolarClient();
    updated = (await polar.subscriptions.update(team.polar_subscription_id, {
      seats,
      proration_behavior: "next_period",
    })) as unknown as Record<string, unknown>;
    updatedAt = new Date();
  } catch (polarError) {
    // Polar never saw the change, so put the previous schedule back, but only
    // while the row still holds this request's value: an overlapping request
    // that has since scheduled something else (and told Polar) must not be
    // undone. If the restore fails, the next subscription webhook rewrites
    // pending_seats from Polar; surface the original Polar error either way.
    let restore = admin.from("teams").update({ pending_seats: previousPending }).eq("id", teamId);
    restore =
      recordedPending === null
        ? restore.is("pending_seats", null)
        : restore.eq("pending_seats", recordedPending);
    const { error: restoreError } = await restore;
    if (restoreError) {
      reportError(
        "[team-billing] failed to restore the seat schedule after a Polar error",
        restoreError,
        { teamId, previousPending }
      );
    }

    throw polarError;
  }

  // Record Polar's own view now rather than waiting for the webhook, stamped
  // with the time Polar confirmed it, so an older read is already outdated.
  try {
    await syncPendingUpdate(teamId, team.polar_subscription_id, updated, updatedAt);
  } catch (syncError) {
    reportError("[team-billing] failed to record the seat schedule from Polar", syncError, {
      teamId,
    });
  }
}

/**
 * Prices a seat change for the confirmation dialog: the exact amount Polar
 * charges (or credits) if the owner confirms now, after spending any unused
 * credit. Reads the live subscription and the customer's order history from
 * Polar so the quote uses Polar's own period bounds and seat count.
 */
export async function quoteTeamSeatChange(
  userId: string,
  teamId: string,
  seats: number
): Promise<SeatChangeQuote> {
  const team = await getTeamForOwner(userId, teamId);
  assertValidSeatCount(seats, team.seats);
  if (!team.polar_subscription_id) {
    throw new TeamBillingError("no_subscription", "No active subscription");
  }

  const polar = createPolarClient();
  const subscription = await polar.subscriptions.get(team.polar_subscription_id);
  const currentSeats = subscription.seats ?? team.seats;
  if (!currentSeats || currentSeats <= 0) {
    throw new TeamBillingError("seat_update_failed", "Could not read the current seat count");
  }

  const orders: Array<{ totalAmount: number; appliedBalanceAmount: number }> = [];
  for await (const order of polar.orders.iterList({
    customer_id: subscription.customer_id,
    limit: 100,
  })) {
    orders.push({
      totalAmount: order.total_amount,
      appliedBalanceAmount: order.applied_balance_amount,
    });
  }

  const pendingSeats = subscription.pending_update?.seats ?? null;

  return quoteSeatChange({
    currentSeats,
    pendingSeats,
    newSeats: seats,
    pricePerSeatCents: Math.round(subscription.amount / currentSeats),
    periodStartMs: Date.parse(subscription.current_period_start),
    periodEndMs: Date.parse(subscription.current_period_end),
    creditBalanceCents: creditBalanceFromOrders(orders),
  });
}

// ---------------------------------------------------------------------------
// Plan changes (Teams and Team Business, monthly or annual)
// ---------------------------------------------------------------------------

/** The Polar error a declined charge maps to, or null for any other error. */
function declinedCharge(error: unknown, what: string): TeamBillingError | null {
  // 402 covers a declined card (PaymentFailed) and a charge that needs the
  // cardholder to authenticate (PaymentActionRequired); neither changes the
  // subscription.
  if (!(error instanceof errors.SubscriptionsUpdate402Error)) return null;
  return new TeamBillingError(
    "payment_failed",
    error.error.error === "PaymentActionRequired"
      ? `Your bank needs you to approve this payment, so ${what} yet. Approve it from the link in your Polar receipt email, or update the card there, and try again.`
      : `Your payment method was declined, so ${what}. Update the card from the link in your Polar receipt email and try again.`
  );
}

/** A team on a live subscription that the owner may change, with its current plan. */
async function teamForPlanChange(
  userId: string,
  teamId: string,
  plan: TeamPlan,
  interval: BillingInterval
): Promise<{
  team: BillingTeam & { polar_subscription_id: string };
  current: { plan: TeamPlan; interval: BillingInterval };
  target: { plan: TeamPlan; interval: BillingInterval };
  productId: string;
  applies: "now" | "renewal";
}> {
  if (plan === "team" && interval === "year") {
    throw new TeamBillingError("not_offered", "Teams is billed monthly only");
  }
  const team = await getTeamForOwner(userId, teamId);
  if (!team.polar_subscription_id || team.subscription_status === null) {
    throw new TeamBillingError("no_subscription", "No active subscription");
  }
  if (team.cancel_at_period_end) {
    throw new TeamBillingError(
      "plan_ending",
      "The subscription is set to end. Keep it first, then change the plan."
    );
  }
  const productId = requireTeamPlanProduct(plan, interval);
  const current = storedTeamPlan(team);
  const target = { plan, interval };
  if (current.plan === plan && current.interval === interval) {
    throw new TeamBillingError("unchanged", "The team is on that plan already");
  }
  if (team.pending_plan) {
    throw new TeamBillingError(
      "change_pending",
      "A plan change is already waiting for the renewal. Keep the current plan first."
    );
  }
  if (plan === "team_business" && team.seats < MIN_TEAM_SEATS) {
    throw new TeamBillingError(
      "seats_below_minimum",
      `Team Business starts at ${MIN_TEAM_SEATS} seats. Add a seat first, then upgrade.`
    );
  }
  return {
    team: team as BillingTeam & { polar_subscription_id: string },
    current,
    target,
    productId,
    applies: isUpgrade(current, target) ? "now" : "renewal",
  };
}

/**
 * Moves a team to another plan or interval. Up (Teams to Team Business, or
 * monthly to annual) changes now: Polar charges the difference ("invoice";
 * within the month it credits the unused share and charges the same share
 * of the new price, and a move to annual starts a new year), and the
 * subscription webhook grants the extra allowance in proportion. Down (Team
 * Business to Teams, annual to monthly) waits for the renewal
 * ("next_period"), shown as pending_plan until then and undone with
 * keepTeamPlan(); page and domain add-ons that only Team Business allows are
 * set to end with the period.
 */
export async function changeTeamPlan(
  userId: string,
  teamId: string,
  plan: TeamPlan,
  interval: BillingInterval
): Promise<{ applied: "now" | "renewal" }> {
  const { team, productId, applies } = await teamForPlanChange(userId, teamId, plan, interval);
  const polar = createPolarClient();

  let updated: Record<string, unknown>;
  let updatedAt: Date;
  try {
    updated = (await polar.subscriptions.update(team.polar_subscription_id, {
      product_id: productId,
      proration_behavior: applies === "now" ? "invoice" : "next_period",
    })) as unknown as Record<string, unknown>;
    updatedAt = new Date();
  } catch (error) {
    const declined = declinedCharge(error, "the plan was not changed");
    if (declined) throw declined;
    if (polarErrorCode(error) === "BelowMinimumSeats") {
      throw new TeamBillingError(
        "seats_below_minimum",
        `Team Business starts at ${MIN_TEAM_SEATS} seats. Add a seat first, then upgrade.`
      );
    }
    throw error;
  }

  // Polar has made the change (and charged for an upgrade), so nothing below
  // may fail the request: the webhooks write the same state, and an error
  // here would only invite a second attempt.
  try {
    if (applies === "now") {
      // The webhook applies it too; this shows the new plan before that arrives.
      await applyTeamSubscriptionState("subscription.updated", teamId, updated);
    } else {
      await syncPendingUpdate(teamId, team.polar_subscription_id, updated, updatedAt);
    }
    // Page and domain add-ons need Team Business: leaving it, they end with the period.
    const { reconcileAddonsWithPlan } = await import("./capacity-billing");
    await reconcileAddonsWithPlan({ kind: "team", teamId });
  } catch (followUpError) {
    reportError(
      "[team-billing] Polar changed the plan but the team row was not updated",
      followUpError,
      { teamId }
    );
  }
  return { applied: applies };
}

/**
 * Drops a plan change waiting for the renewal, so the team renews on its
 * plan, and add-ons the change set to end come back. Polar keeps seats and
 * plan in one pending update and clears both together, so a seat reduction
 * that was scheduled with it is scheduled again.
 */
export async function keepTeamPlan(userId: string, teamId: string): Promise<void> {
  const team = await getTeamForOwner(userId, teamId);
  if (!team.polar_subscription_id || team.subscription_status === null) {
    throw new TeamBillingError("no_subscription", "No active subscription");
  }
  if (!team.pending_plan) {
    throw new TeamBillingError("unchanged", "No plan change is waiting");
  }

  const polar = createPolarClient();
  let updated = (await polar.subscriptions.update(team.polar_subscription_id, {
    pending_update: null,
  })) as unknown as Record<string, unknown>;
  let seatsLost = false;
  if (team.pending_seats !== null && team.pending_seats < team.seats) {
    try {
      updated = (await polar.subscriptions.update(team.polar_subscription_id, {
        seats: team.pending_seats,
        proration_behavior: "next_period",
      })) as unknown as Record<string, unknown>;
    } catch (seatError) {
      // The plan is kept, but Polar cleared the seat reduction with it.
      reportError(
        "[team-billing] kept the plan but could not schedule the seat reduction again",
        loggablePolarError(seatError),
        { teamId }
      );
      seatsLost = true;
    }
  }
  await syncPendingUpdate(teamId, team.polar_subscription_id, updated, new Date());

  const { reconcileAddonsWithPlan } = await import("./capacity-billing");
  await reconcileAddonsWithPlan({ kind: "team", teamId });

  if (seatsLost) {
    throw new TeamBillingError(
      "seat_reduction_lost",
      `The plan is kept, but the reduction to ${team.pending_seats} seats was dropped with the plan change. Set the seats again to remove them at the renewal.`
    );
  }
}

/** The price of a seat on a Polar product for `seats` seats, in cents. */
function seatPriceFromProduct(product: unknown, seats: number): number | null {
  const prices = asRecord(product)?.prices;
  if (!Array.isArray(prices)) return null;
  for (const price of prices) {
    const record = asRecord(price);
    if (!record || record.is_archived === true) continue;
    const tiers = asRecord(record.seat_tiers)?.tiers;
    if (!Array.isArray(tiers)) continue;
    for (const tier of tiers) {
      const t = asRecord(tier);
      if (!t || typeof t.price_per_seat !== "number") continue;
      const min = typeof t.min_seats === "number" ? t.min_seats : 1;
      const max = typeof t.max_seats === "number" ? t.max_seats : Number.POSITIVE_INFINITY;
      if (seats >= min && seats <= max) return t.price_per_seat;
    }
  }
  return null;
}

/**
 * Prices a plan change for the confirmation dialog from Polar's live
 * subscription, the new product's seat price and the customer's unused
 * credit.
 */
export async function quoteTeamPlanChange(
  userId: string,
  teamId: string,
  plan: TeamPlan,
  interval: BillingInterval
): Promise<PlanChangeQuote> {
  const { team, current, productId, applies } = await teamForPlanChange(
    userId,
    teamId,
    plan,
    interval
  );
  const polar = createPolarClient();
  const [subscription, product] = await Promise.all([
    polar.subscriptions.get(team.polar_subscription_id),
    polar.products.get(productId),
  ]);
  const seats = subscription.seats ?? team.seats;
  const pricePerSeat = seatPriceFromProduct(product, seats);
  if (pricePerSeat === null) {
    throw new TeamBillingError("not_offered", "Could not read the plan's price");
  }

  let creditBalanceCents = 0;
  if (applies === "now") {
    const orders: Array<{ totalAmount: number; appliedBalanceAmount: number }> = [];
    for await (const order of polar.orders.iterList({
      customer_id: subscription.customer_id,
      limit: 100,
    })) {
      orders.push({
        totalAmount: order.total_amount,
        appliedBalanceAmount: order.applied_balance_amount,
      });
    }
    creditBalanceCents = creditBalanceFromOrders(orders);
  }

  return quotePlanChange({
    plan,
    interval,
    seats,
    currentInterval: current.interval,
    currentAmountCents: subscription.amount,
    newPricePerSeatCents: pricePerSeat,
    applies,
    periodStartMs: Date.parse(subscription.current_period_start),
    periodEndMs: Date.parse(subscription.current_period_end),
    creditBalanceCents,
  });
}

/** Cancels immediately. Used by team deletion, which revokes before deleting the row. */
export async function revokeTeamSubscription(polarSubscriptionId: string): Promise<void> {
  const polar = createPolarClient();
  await polar.subscriptions.revoke(polarSubscriptionId);
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
  const seat = await polar.customerSeats.assignSeat({
    subscription_id: subscriptionId,
    email,
    // Defaults to false, which makes Polar email an invitation. Membership is
    // granted by our own invite flow, so claim the seat immediately instead.
    immediate_claim: true,
    metadata: {
      userId: memberUserId,
      teamId,
    },
  });

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
      const list = await polar.customerSeats.listSeats({ subscription_id: subscriptionId });
      const wanted = email.toLowerCase();
      const match = list.seats.find(
        (seat) =>
          seat.status !== "revoked" &&
          (seat.customer_email?.toLowerCase() === wanted || seat.email?.toLowerCase() === wanted)
      );
      targetSeatId = match?.id ?? null;
    }

    if (!targetSeatId) {
      return;
    }

    await polar.customerSeats.revokeSeat(targetSeatId);
  } catch (error) {
    reportError("[team-billing] failed to revoke Polar seat", loggablePolarError(error), {
      teamId,
      seatId,
    });
  }
}

/**
 * Gives the team owner a claimed Polar seat, so Polar's assigned seats match
 * our member count (the owner occupies one of the purchased seats). Polar
 * assigns the owner member a seat at checkout for some customers and not for
 * others, so this records an existing seat when there is one and assigns one
 * otherwise. Assigning twice answers SeatAlreadyAssigned, which makes
 * concurrent webhook deliveries harmless.
 *
 * Best effort: billing does not depend on it (Polar charges for the seat
 * count, not for assignments), so failures are logged and the next
 * subscription event retries.
 */
export async function ensureOwnerSeat(teamId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: owner, error: ownerError } = await admin
      .from("team_members")
      .select("user_id, polar_seat_id")
      .eq("team_id", teamId)
      .eq("role", "owner")
      .maybeSingle();
    if (ownerError) throw ownerError;
    if (!owner) return;

    const { data: team, error: teamError } = await admin
      .from("teams")
      .select("polar_subscription_id, subscription_status")
      .eq("id", teamId)
      .maybeSingle();
    if (teamError) throw teamError;
    if (!team?.polar_subscription_id || team.subscription_status === null) return;
    const subscriptionId = team.polar_subscription_id;

    const { data: user, error: userError } = await admin
      .from("users")
      .select("email")
      .eq("id", owner.user_id)
      .maybeSingle();
    if (userError) throw userError;
    if (!user?.email) return;
    const email = user.email;

    const polar = createPolarClient();
    const wanted = email.toLowerCase();
    const listOwnerSeats = async () => {
      const list = await polar.customerSeats.listSeats({ subscription_id: subscriptionId });
      return list.seats.filter(
        (seat) =>
          seat.status !== "revoked" &&
          (seat.customer_email?.toLowerCase() === wanted || seat.email?.toLowerCase() === wanted)
      );
    };

    const ownerSeats = await listOwnerSeats();
    if (owner.polar_seat_id) {
      // The stored id must still be the owner's live seat in THIS subscription:
      // a revoked subscription leaves the old id behind, and Polar hands
      // revoked seat ids to other people when it recycles them.
      if (ownerSeats.some((seat) => seat.id === owner.polar_seat_id)) return;

      const { error: clearError } = await admin
        .from("team_members")
        .update({ polar_seat_id: null })
        .eq("team_id", teamId)
        .eq("user_id", owner.user_id)
        .eq("polar_seat_id", owner.polar_seat_id);
      if (clearError) throw clearError;
    }

    let seatId: string | null = ownerSeats[0]?.id ?? null;
    if (!seatId) {
      try {
        seatId = await assignTeamSeat(teamId, email, owner.user_id);
      } catch (error) {
        if (polarErrorCode(error) !== "SeatAlreadyAssigned") throw error;
        seatId = (await listOwnerSeats())[0]?.id ?? null;
      }
    }
    if (!seatId) return;

    const { error: updateError } = await admin
      .from("team_members")
      .update({ polar_seat_id: seatId })
      .eq("team_id", teamId)
      .eq("user_id", owner.user_id)
      .is("polar_seat_id", null);
    if (updateError) throw updateError;
  } catch (error) {
    reportError(
      "[team-billing] failed to give the team owner a Polar seat",
      loggablePolarError(error),
      { teamId }
    );
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

    const externalId = asNonEmptyString(customer.external_id);
    if (externalId?.startsWith("team:")) {
      return asNonEmptyString(externalId.slice("team:".length));
    }
  }

  const seatMetadata = asRecord(data.seat_metadata) ?? asRecord(data.metadata);
  return seatMetadata ? asNonEmptyString(seatMetadata.teamId) : null;
}

function extractSeatUserId(data: Record<string, unknown>): string | null {
  const metadata = asRecord(data.seat_metadata) ?? asRecord(data.metadata);
  return metadata ? asNonEmptyString(metadata.userId) : null;
}

function extractSeatEmail(data: Record<string, unknown>): string | null {
  return asNonEmptyString(data.customer_email) ?? asNonEmptyString(data.email);
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

/** Seats in the subscription's pending update, or null when nothing is scheduled. */
function pendingSeatsFromEvent(data: Record<string, unknown>): number | null {
  const pending = asRecord(data.pending_update);
  const seats = pending?.seats;
  return typeof seats === "number" && Number.isInteger(seats) && seats > 0 ? seats : null;
}

/**
 * The plan in the subscription's pending update, or null when no other plan
 * is scheduled. Scheduling the current product again leaves it in Polar's
 * pending update, which changes nothing and reads as nothing here.
 */
function pendingPlanFromEvent(
  data: Record<string, unknown>
): { plan: TeamPlan; interval: BillingInterval } | null {
  const pending = teamPlanForProduct(asNonEmptyString(asRecord(data.pending_update)?.product_id));
  if (!pending) return null;
  const current = teamPlanForProduct(
    asNonEmptyString(data.product_id) ?? asNonEmptyString(asRecord(data.product)?.id)
  );
  if (current && current.plan === pending.plan && current.interval === pending.interval) {
    return null;
  }
  return pending;
}

/**
 * Mirrors a Polar subscription's scheduled change (seats and plan share one
 * pending update in Polar) into `teams.pending_seats`, `pending_plan` and
 * `pending_interval`, accepting only a newer observation than the one
 * already applied: an older read must not restore a schedule (and with it a
 * looser member cap) that Polar has since replaced.
 *
 * The version is our own clock, `observedAt`, not Polar's: Polar leaves the
 * subscription's `modified_at` unchanged when a pending update is scheduled
 * or cleared, so its timestamps cannot order these changes. Callers pass a
 * time at which the given state was already true in Polar: the arrival of an
 * update response (Polar commits before it answers), or the start of a read.
 */
async function syncPendingUpdate(
  teamId: string,
  subscriptionId: string,
  subscription: Record<string, unknown>,
  observedAt: Date
): Promise<void> {
  const asOf = observedAt.toISOString();
  const pendingPlan = pendingPlanFromEvent(subscription);
  const admin = createAdminClient();
  const { error } = await admin
    .from("teams")
    .update({
      pending_seats: pendingSeatsFromEvent(subscription),
      pending_plan: pendingPlan?.plan ?? null,
      pending_interval: pendingPlan?.interval ?? null,
      pending_seats_as_of: asOf,
    })
    .eq("id", teamId)
    .eq("polar_subscription_id", subscriptionId)
    .or(`pending_seats_as_of.is.null,pending_seats_as_of.lt."${asOf}"`);

  if (error) {
    throw error;
  }
}

/**
 * The subscription as Polar has it now, over the event's own copy: webhook
 * payloads cannot be ordered against each other (a late one would put back a
 * product or seat count already changed), but Polar's current state can.
 * A failed read fails the webhook, like any other processing error, so Polar
 * redelivers it: a schedule changed in Polar itself may produce no other
 * event before the renewal, and pending_seats caps members until then.
 */
async function currentTeamSubscription(
  data: Record<string, unknown>
): Promise<{ subscription: Record<string, unknown>; observedAt: Date }> {
  const observedAt = new Date();
  const subscriptionId = asNonEmptyString(data.id);
  if (!subscriptionId) return { subscription: data, observedAt };
  const current = asRecord(await createPolarClient().subscriptions.get(subscriptionId));
  return { subscription: { ...data, ...(current ?? {}) }, observedAt };
}

/**
 * The pro rata per-seat allowance for the rest of the quota period when a
 * team moves up from Teams to Team Business inside it: Polar charged only the
 * remaining share of the period ("invoice"), so the extra requests and pages
 * come in the same share, and the trigger gives the full allowance back when
 * the period moves on (migration 00082). The time it is applied stands in
 * for the change's: Polar's modified_at does not move with a product change,
 * so a retry grants a little less, never more.
 */
function upgradeProration(
  seats: number,
  window: { start: string; end: string },
  nowMs: number
): { prorated_seat_requests: number; prorated_seat_pages: number } {
  const left = remainingShare(window.start, window.end, nowMs);
  const before = ENTITLEMENTS.team;
  const after = ENTITLEMENTS.team_business;
  // Teams' pages are the team's, Team Business's are per seat.
  const pagesBefore = before.parsedPages / Math.max(1, seats);
  return {
    prorated_seat_requests:
      before.requestLimit + Math.round((after.requestLimit - before.requestLimit) * left),
    prorated_seat_pages: Math.round(pagesBefore + (after.parsedPages - pagesBefore) * left),
  };
}

async function applyTeamSubscriptionState(
  eventType: string,
  teamId: string,
  event: Record<string, unknown>
): Promise<void> {
  const admin = createAdminClient();
  const { data: team, error } = await admin
    .from("teams")
    .select(
      "polar_subscription_id, subscription_status, seats, period_start, period_end, business, billing_interval, billing_period_end, prorated_window"
    )
    .eq("id", teamId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!team) {
    return;
  }

  const { subscription: data, observedAt } = await currentTeamSubscription(event);
  const subscriptionId = asNonEmptyString(data.id);
  const customerId = asNonEmptyString(data.customer_id);

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

  // The plan and interval come from the product; a product that is none of
  // today's team plans is the original Teams product.
  const sold = teamPlanForProduct(
    asNonEmptyString(data.product_id) ?? asNonEmptyString(asRecord(data.product)?.id)
  ) ?? { plan: "team" as const, interval: "month" as const };
  const business = sold.plan === "team_business";
  const annual = sold.interval === "year";

  // A different subscription id means a brand-new subscription (the team was
  // deactivated and re-subscribed) — that starts a fresh pooled quota. Repeat
  // events for the same subscription must never clear usage.
  const isNewSubscription =
    subscriptionId !== null && subscriptionId !== team.polar_subscription_id;

  const incomingPeriodStart = parseEventTimestamp(data.current_period_start);
  const incomingPeriodEnd = parseEventTimestamp(data.current_period_end);
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

  // Annual Team Business: the quota renews monthly (process_billing_period_resets)
  // while Polar's period runs for the year, as for annual personal plans, so
  // the quota period moves only when Polar's year starts (a new
  // subscription, a yearly renewal, or a switch to annual, which restarts
  // the billing period).
  const incomingBillingEndMs = incomingPeriodEnd ? Date.parse(incomingPeriodEnd) : null;
  const storedBillingEndMs = team.billing_period_end ? Date.parse(team.billing_period_end) : null;
  const newYear =
    annual &&
    (isNewSubscription ||
      team.billing_interval !== "year" ||
      (incomingBillingEndMs !== null &&
        (storedBillingEndMs === null || incomingBillingEndMs > storedBillingEndMs)));
  const period: TeamUpdate = annual
    ? // A renewal applied after the monthly cron already moved the period on
      // (more than a month late) keeps the newer period.
      newYear && incomingPeriodStart && !isStalePeriod
      ? { period_start: incomingPeriodStart, period_end: addMonthUtc(incomingPeriodStart) }
      : {}
    : {
        period_start: isStalePeriod ? undefined : incomingPeriodStart,
        period_end: isStalePeriod ? undefined : incomingPeriodEnd,
      };
  // A year that starts after the cron fallback already moved the quota
  // period there keeps the usage counted since.
  const resetsUsage = annual
    ? isNewSubscription ||
      (newYear &&
        (storedPeriodStartMs === null ||
          incomingPeriodStartMs === null ||
          storedPeriodStartMs < incomingPeriodStartMs))
    : isNewSubscription || isRenewal;

  // Teams to Team Business inside the period: the extra allowance pro rata
  // (see upgradeProration). Later events in the same window keep it; a new
  // window drops it (the request-limit trigger).
  const sameWindow = !resetsUsage && !isStalePeriod;
  let proration: TeamUpdate = {};
  if (
    sameWindow &&
    business &&
    !team.business &&
    team.subscription_status !== null &&
    team.period_start &&
    team.period_end
  ) {
    proration = {
      prorated_window: team.period_start,
      ...upgradeProration(
        seats,
        {
          start: incomingPeriodStart ?? team.period_start,
          end: incomingPeriodEnd ?? team.period_end,
        },
        Date.now()
      ),
    };
  } else if (!(sameWindow && business && team.prorated_window === team.period_start)) {
    proration = { prorated_window: null, prorated_seat_requests: null, prorated_seat_pages: null };
  }

  // created/updated/active all describe a live subscription, and for teams a
  // null subscription_status IS the deactivation gate (capture_webhook stops
  // billing the pool, accept_team_invite refuses, the dashboard shows
  // suspended). An unrecognized status value must therefore never null the
  // gate: keep the stored status, or default to active for a first event.
  // A payment that failed (past_due) keeps the team, and with it Team
  // Business, live while Polar retries the card.
  const status =
    normalizeStoredSubscriptionStatus(data.status) ?? team.subscription_status ?? "active";

  // subscription_status, request_limit and both period bounds are written in a
  // single statement on purpose: a team with a status but no request_limit
  // hard-429s every request, and one with a status but no period_end never
  // resets. They must never be observable apart. The request-limit trigger
  // computes the same limit (with any pro rata allowance) from the row.
  const patch: TeamUpdate = {
    polar_customer_id: customerId ?? undefined,
    polar_subscription_id: subscriptionId ?? undefined,
    subscription_status: status,
    seats,
    business,
    request_limit: teamRequestLimit(seats, business),
    ...proration,
    billing_interval: sold.interval,
    billing_period_end: isStalePeriod && !annual ? undefined : incomingPeriodEnd,
    ...period,
    cancel_at_period_end:
      typeof data.cancel_at_period_end === "boolean" ? data.cancel_at_period_end : false,
    // The checkout that produced this subscription is no longer pending.
    pending_checkout: null,
  };

  // Every write is compare-and-swapped on the state that was read. This keeps
  // two failure modes out: overlapping deliveries of the same renewal both
  // zeroing the pool (erasing captures billed between the writes), and an
  // updated/active event read before a concurrent revoke resurrecting the
  // revoked subscription's state after it. The loser's write matches no rows
  // and throws, so Polar delivers the event again and it is applied to the
  // state that won.
  let guarded = admin
    .from("teams")
    .update(resetsUsage ? { ...patch, requests_used: 0 } : patch)
    .eq("id", teamId);
  guarded =
    team.polar_subscription_id === null
      ? guarded.is("polar_subscription_id", null)
      : guarded.eq("polar_subscription_id", team.polar_subscription_id);
  guarded =
    team.period_start === null
      ? guarded.is("period_start", null)
      : guarded.eq("period_start", team.period_start);
  // The plan read with the row too: a product switch inside the period keeps
  // the subscription and its period, and a write from a read before it must
  // not put the old plan (and its allowance) back.
  guarded = guarded.eq("business", team.business);
  guarded =
    team.billing_interval === null
      ? guarded.is("billing_interval", null)
      : guarded.eq("billing_interval", team.billing_interval);

  const { data: written, error: guardedError } = await guarded.select("id");
  if (guardedError) throw guardedError;
  if (!written || written.length === 0) {
    // Another write got there first: fail, so Polar delivers the event again
    // and it is applied to Polar's state then.
    throw new TeamBillingError(
      "concurrent_update",
      "The team changed while this subscription event was applied"
    );
  }

  // Separately from the guarded write above: seat and plan changes within one
  // period share its subscription id and period start, so the pending
  // schedule is fenced on the time of the read instead.
  if (subscriptionId !== null) {
    await syncPendingUpdate(teamId, subscriptionId, data, observedAt);
  }
}

/**
 * The stored subscription id when a cancel/uncancel/revoke event still
 * describes the subscription the team holds, else null. Cancel and uncancel
 * write a non-null `subscription_status`, which is the team's access gate — so
 * a retried `subscription.canceled` landing after `subscription.revoked` would
 * silently re-open a deactivated team's pool, and neither reset CTE could ever
 * clean it up (both require `period_end` non-null). A `canceled` that arrives
 * too early is safe to drop: the `created`/`updated` event that follows
 * carries `cancel_at_period_end` and re-applies it.
 *
 * Revocation needs the same check in the other direction: after a team
 * replaces its subscription, a delayed or retried `subscription.revoked` for
 * the old one must not clear the row that now tracks the new, paying
 * subscription.
 *
 * Callers condition their write on the returned id (see
 * `updateTeamForSubscription`), so a subscription replaced between this read
 * and the write turns the write into a no-op instead of clobbering the
 * replacement.
 */
async function liveSubscriptionIdForEvent(
  teamId: string,
  data: Record<string, unknown>
): Promise<string | null> {
  const storedSubscriptionId = await getTeamSubscriptionId(teamId);
  if (!storedSubscriptionId) {
    return null;
  }

  const eventSubscriptionId = asNonEmptyString(data.id);
  return eventSubscriptionId === null || eventSubscriptionId === storedSubscriptionId
    ? storedSubscriptionId
    : null;
}

/** Applies a terminal-transition patch only while the team still tracks `subscriptionId`. */
async function updateTeamForSubscription(
  teamId: string,
  subscriptionId: string,
  patch: TeamUpdate
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("teams")
    .update(patch)
    .eq("id", teamId)
    .eq("polar_subscription_id", subscriptionId);

  if (error) {
    throw error;
  }
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

  // Shares before the membership row, like remove/leave: a failure here
  // throws, the webhook answers 500, and Polar's redelivery retries the whole
  // removal, so cleanup cannot be silently lost.
  await removeMemberShares(teamId, memberUserId);

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
      await applyTeamSubscriptionState(eventType, teamId, data);
      await ensureOwnerSeat(teamId);
      return;

    case "subscription.canceled": {
      const liveId = await liveSubscriptionIdForEvent(teamId, data);
      if (!liveId) {
        return;
      }

      await updateTeamForSubscription(teamId, liveId, {
        cancel_at_period_end: true,
        subscription_status: "canceled",
      });
      return;
    }

    case "subscription.uncanceled": {
      const liveId = await liveSubscriptionIdForEvent(teamId, data);
      if (!liveId) {
        return;
      }

      await updateTeamForSubscription(teamId, liveId, {
        cancel_at_period_end: false,
        subscription_status: normalizeStoredSubscriptionStatus(data.status) ?? "active",
      });
      return;
    }

    case "subscription.revoked": {
      const liveId = await liveSubscriptionIdForEvent(teamId, data);
      if (!liveId) {
        return;
      }

      // Nulling the status is what deactivates the team: capture_webhook and the
      // gating helpers key off it. seats/requests_used/request_limit are kept so
      // the period's usage stays visible until a new subscription resets it.
      await updateTeamForSubscription(teamId, liveId, {
        subscription_status: null,
        polar_subscription_id: null,
        cancel_at_period_end: false,
        period_start: null,
        period_end: null,
        // A pre-revoke checkout session must not be resurrected by the reuse
        // path after a resubscribe.
        pending_checkout: null,
        pending_seats: null,
        pending_seats_as_of: null,
        pending_plan: null,
        pending_interval: null,
        billing_interval: null,
        billing_period_end: null,
        // Recurring blocks, overage and Team Business need an active team;
        // one-time blocks stay. Dropping Team Business keeps its retention
        // for 7 days (a trigger, migration 00067).
        business: false,
        block_requests: 0,
        overage_active: false,
      });
      return;
    }

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
