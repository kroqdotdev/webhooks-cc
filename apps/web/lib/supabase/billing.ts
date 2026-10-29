import {
  createPolarClient,
  getPolarCheckoutConfig,
  loggablePolarError,
  planForProduct,
  planProductId,
  type BillingInterval,
  type PaidPlan,
} from "@/lib/polar";
import { planEntitlements } from "@/lib/entitlements";
import { reportError } from "@/lib/observability";
import { createAdminClient } from "./admin";
import {
  asNonEmptyString,
  asRecord,
  normalizeStoredSubscriptionStatus,
  parseEventTimestamp,
} from "./billing-shared";
import type { Database } from "./database";

const FREE_REQUEST_LIMIT = 50;

type UserRow = Database["public"]["Tables"]["users"]["Row"];

class BillingActionError extends Error {
  code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "BillingActionError";
    this.code = code;
  }
}

type BillingUser = Pick<
  UserRow,
  | "id"
  | "email"
  | "name"
  | "plan"
  | "polar_customer_id"
  | "polar_subscription_id"
  | "cancel_at_period_end"
  | "billing_interval"
  | "pending_plan"
>;

interface BillingPeriodResetRow {
  processed: number;
  downgraded: number;
  renewed: number;
}

export async function getBillingUser(userId: string): Promise<BillingUser> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("users")
    .select(
      "id, email, name, plan, polar_customer_id, polar_subscription_id, cancel_at_period_end, billing_interval, pending_plan"
    )
    .eq("id", userId)
    .maybeSingle<BillingUser>();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new BillingActionError("user_not_found", "User not found");
  }

  return data;
}

async function updateUserById(
  userId: string,
  patch: Database["public"]["Tables"]["users"]["Update"]
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("users").update(patch).eq("id", userId);

  if (error) {
    throw error;
  }
}

/**
 * Applies a terminal-transition patch only while the user still holds the
 * subscription the event is about. With several subscriptions per customer
 * (the request add-ons), and after a resubscribe, an event for another
 * subscription must not touch the plan. Events without an id keep the old
 * behaviour.
 */
async function updateUserForSubscription(
  userId: string,
  subscriptionId: string | null,
  patch: Database["public"]["Tables"]["users"]["Update"]
): Promise<void> {
  const admin = createAdminClient();
  let query = admin.from("users").update(patch).eq("id", userId);
  if (subscriptionId) query = query.eq("polar_subscription_id", subscriptionId);
  const { error } = await query;

  if (error) {
    throw error;
  }
}

async function findUserIdByPolarCustomerId(customerId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("users")
    .select("id")
    .eq("polar_customer_id", customerId)
    .maybeSingle<{ id: string }>();

  if (error) {
    throw error;
  }

  return data?.id ?? null;
}

export async function ensurePolarCustomerId(user: BillingUser): Promise<string> {
  if (user.polar_customer_id) {
    return user.polar_customer_id;
  }

  const polar = createPolarClient();
  const customer = await polar.customers.create({
    email: user.email,
    name: user.name ?? undefined,
    external_id: user.id,
    metadata: {
      userId: user.id,
    },
  });

  await updateUserById(user.id, {
    polar_customer_id: customer.id,
  });

  return customer.id;
}

function extractCustomerUserId(data: Record<string, unknown>): string | null {
  const customer = asRecord(data.customer);
  const metadata = customer ? asRecord(customer.metadata) : null;
  const metadataUserId = metadata ? asNonEmptyString(metadata.userId) : null;
  if (metadataUserId) {
    return metadataUserId;
  }

  return customer ? asNonEmptyString(customer.external_id) : null;
}

export async function resolveWebhookUserId(data: Record<string, unknown>): Promise<string | null> {
  const explicitUserId = extractCustomerUserId(data);
  if (explicitUserId) {
    return explicitUserId;
  }

  const customerId = asNonEmptyString(data.customer_id);
  if (!customerId) {
    return null;
  }

  return findUserIdByPolarCustomerId(customerId);
}

async function callUntypedRpc<T>(
  fn: string,
  params?: Record<string, unknown>
): Promise<{ data: T | null; error: { message: string } | null }> {
  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as (
    functionName: string,
    functionParams?: Record<string, unknown>
  ) => Promise<{ data: T | null; error: { message: string } | null }>;

  return rpc(fn, params);
}

/**
 * A checkout for a paid plan, for an account without one. An account that
 * already pays changes plan with changePlanForUser() instead, so it never
 * ends up with two plan subscriptions.
 */
export async function createCheckoutForUser(
  userId: string,
  plan: PaidPlan = "pro",
  interval: BillingInterval = "month"
): Promise<string> {
  const user = await getBillingUser(userId);
  if (user.plan !== "free" && user.polar_subscription_id) {
    throw new BillingActionError(
      user.plan === "pro" ? "already_pro" : "already_subscribed",
      "You already have a plan; change it instead"
    );
  }
  const productId = planProductId(plan, interval);
  if (!productId) {
    throw new BillingActionError("not_offered", "That plan is not available");
  }

  const polar = createPolarClient();
  const { appUrl } = getPolarCheckoutConfig();
  const customerId = await ensurePolarCustomerId(user);

  const checkout = await polar.checkouts.create({
    products: [productId],
    success_url: `${appUrl}/account/plan?upgraded=${plan}`,
    customer_id: customerId,
  });

  return checkout.url;
}

const PLAN_RANK: Record<string, number> = { free: 0, pro: 1, business: 2 };

/**
 * Moves a paying account to another plan or interval. A monthly plan going
 * up a tier (Pro to Business) changes now: Polar charges the difference for
 * the rest of the period ("invoice"), and the webhook grants the new plan's
 * extra requests and pages in the same proportion, so a charge for part of
 * a period never buys a whole period's capacity. Everything else (another
 * interval, a lower tier) waits for the renewal ("next_period", shown as
 * pending_plan until then), and the page add-ons that only Business allows
 * are set to end with the period.
 */
export async function changePlanForUser(
  userId: string,
  plan: PaidPlan,
  interval: BillingInterval
): Promise<{ applied: "now" | "renewal" }> {
  const user = await getBillingUser(userId);
  if (!user.polar_subscription_id || user.plan === "free") {
    throw new BillingActionError("no_subscription", "Choose a plan first");
  }
  if (user.cancel_at_period_end) {
    throw new BillingActionError(
      "plan_ending",
      "Your plan is set to end. Keep it first, then change it."
    );
  }
  const productId = planProductId(plan, interval);
  if (!productId) {
    throw new BillingActionError("not_offered", "That plan is not available");
  }
  const currentInterval: BillingInterval = user.billing_interval === "year" ? "year" : "month";
  if (plan === user.plan && interval === currentInterval) {
    throw new BillingActionError("unchanged", "That is your plan already");
  }
  const now =
    PLAN_RANK[plan] > PLAN_RANK[user.plan] && interval === "month" && currentInterval === "month";

  await createPolarClient().subscriptions.update(user.polar_subscription_id, {
    product_id: productId,
    proration_behavior: now ? "invoice" : "next_period",
  });
  if (!now) {
    // The webhook records it too; this shows it before that arrives.
    await updateUserById(user.id, { pending_plan: plan, pending_interval: interval });
    // Page add-ons need Business: leaving it, they end with the period.
    const { reconcileAddonsWithPlan } = await import("./capacity-billing");
    await reconcileAddonsWithPlan({ kind: "user", userId });
  }
  return { applied: now ? "now" : "renewal" };
}

/**
 * Drops a plan change waiting for the renewal, so the plan renews as it
 * is, and page add-ons a move away from Business set to end come back.
 */
export async function keepCurrentPlanForUser(userId: string): Promise<void> {
  const user = await getBillingUser(userId);
  if (!user.polar_subscription_id || user.plan === "free") {
    throw new BillingActionError("no_subscription", "Choose a plan first");
  }
  if (!user.pending_plan) {
    throw new BillingActionError("unchanged", "No plan change is waiting");
  }
  await createPolarClient().subscriptions.update(user.polar_subscription_id, {
    pending_update: null,
  });
  await updateUserById(user.id, { pending_plan: null, pending_interval: null });
  const { reconcileAddonsWithPlan } = await import("./capacity-billing");
  await reconcileAddonsWithPlan({ kind: "user", userId });
}

export async function cancelSubscriptionForUser(userId: string): Promise<void> {
  const user = await getBillingUser(userId);
  if (!user.polar_subscription_id) {
    throw new BillingActionError("no_subscription", "No active subscription");
  }

  const polar = createPolarClient();
  await polar.subscriptions.update(user.polar_subscription_id, { cancel_at_period_end: true });

  await updateUserById(user.id, {
    cancel_at_period_end: true,
  });
}

export async function resubscribeForUser(userId: string): Promise<void> {
  const user = await getBillingUser(userId);
  if (!user.polar_subscription_id) {
    throw new BillingActionError("no_subscription", "No subscription to reactivate");
  }
  if (!user.cancel_at_period_end) {
    throw new BillingActionError("not_scheduled", "Subscription is not scheduled for cancellation");
  }

  const polar = createPolarClient();
  await polar.subscriptions.update(user.polar_subscription_id, { cancel_at_period_end: false });

  await updateUserById(user.id, {
    cancel_at_period_end: false,
  });
}

const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

/** The subscription as Polar has it now; the event's own copy for one without an id. */
async function currentSubscription(
  event: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const id = asNonEmptyString(event.id);
  if (!id) return event;
  const current = await createPolarClient().subscriptions.get(id);
  return (asRecord(current) ?? event) as Record<string, unknown>;
}

/** Polar's errors propagate, so the event is delivered again later. */
async function isLiveSubscription(id: string): Promise<boolean> {
  const subscription = asRecord(await createPolarClient().subscriptions.get(id));
  return LIVE_STATUSES.has(String(subscription?.status));
}

async function revokeSubscriptionQuietly(id: string): Promise<void> {
  try {
    await createPolarClient().subscriptions.revoke(id);
  } catch (error) {
    reportError(
      "[billing] could not revoke a second plan subscription",
      loggablePolarError(error),
      {
        subscriptionId: id,
      }
    );
    throw error;
  }
}

/**
 * One month after an ISO time, in UTC, kept on the last day of a shorter
 * month as Postgres does (Jan 31 gives Feb 28, not Mar 3).
 */
export function addMonthUtc(iso: string): string {
  const from = new Date(iso);
  const next = new Date(from);
  next.setUTCDate(1);
  next.setUTCMonth(from.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  return next.toISOString();
}

/** The share of the period [start, end) still to come at `now`, 0 to 1. */
export function remainingShare(start: string, end: string, now: number): number {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  return Math.min(1, Math.max(0, (to - now) / (to - from)));
}

export async function applyPolarWebhookEvent(eventType: string, payload: unknown): Promise<void> {
  const event = asRecord(payload);
  if (!event) {
    return;
  }
  const data = event;

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
    case "subscription.updated": {
      // Polar's payloads cannot be ordered against each other (a late one
      // would put back a plan or interval already changed), so the
      // subscription's current state is applied, as for the add-ons.
      const data = await currentSubscription(event);
      const userId = await resolveWebhookUserId(data);
      if (!userId) {
        return;
      }

      const admin = createAdminClient();
      const { data: stored, error: storedError } = await admin
        .from("users")
        .select(
          "polar_subscription_id, subscription_status, plan, period_start, period_end, billing_interval, billing_period_end, prorated_window"
        )
        .eq("id", userId)
        .maybeSingle<{
          polar_subscription_id: string | null;
          subscription_status: "active" | "canceled" | "past_due" | null;
          plan: string;
          period_start: string | null;
          period_end: string | null;
          billing_interval: "month" | "year" | null;
          billing_period_end: string | null;
          prorated_window: string | null;
        }>();

      if (storedError) throw storedError;
      if (!stored) return;

      const currentPeriodStart = parseEventTimestamp(data.current_period_start);
      const currentPeriodEnd = parseEventTimestamp(data.current_period_end);
      const customerId = asNonEmptyString(data.customer_id);
      const subscriptionId = asNonEmptyString(data.id);

      // Same renewal semantics as applyTeamSubscriptionState in team-billing.ts.
      // A new subscription id starts a fresh quota. A same-subscription event
      // whose period start moved forward is a renewal and must clear usage HERE:
      // this same write pushes period_end into the future, which blinds the
      // per-minute cron fallback reset (it only touches rows with
      // period_end <= now()). A period start older than the stored one is a
      // stale out-of-order delivery whose bounds must not roll the period back.
      const isNewSubscription =
        subscriptionId !== null && subscriptionId !== stored.polar_subscription_id;

      if (isNewSubscription) {
        // An ended subscription that is not the account's (an old one's late
        // event) changes nothing.
        if (!LIVE_STATUSES.has(String(data.status))) return;
        // A second live plan subscription (two checkouts completed in two
        // tabs): the account keeps the one it has, and the new one ends
        // before it charges again. Someone refunds what it charged.
        if (
          stored.polar_subscription_id &&
          (await isLiveSubscription(stored.polar_subscription_id))
        ) {
          await revokeSubscriptionQuietly(subscriptionId);
          reportError("[billing] a second plan subscription was revoked; refund it", undefined, {
            subscriptionId,
          });
          return;
        }
      }

      const incomingPeriodStartMs = currentPeriodStart ? Date.parse(currentPeriodStart) : null;
      const storedPeriodStartMs = stored.period_start ? Date.parse(stored.period_start) : null;

      const isRenewal =
        !isNewSubscription &&
        incomingPeriodStartMs !== null &&
        storedPeriodStartMs !== null &&
        incomingPeriodStartMs > storedPeriodStartMs;

      const isStalePeriod =
        !isNewSubscription &&
        incomingPeriodStartMs !== null &&
        storedPeriodStartMs !== null &&
        incomingPeriodStartMs < storedPeriodStartMs;

      // The plan and interval come from the product; a product that is none
      // of today's plans is the original Pro.
      const sold = planForProduct(
        asNonEmptyString(data.product_id) ?? asNonEmptyString(asRecord(data.product)?.id)
      ) ?? { plan: "pro" as const, interval: "month" as const };
      const annual = sold.interval === "year";

      // An annual plan's quota renews monthly (process_billing_period_resets)
      // while Polar's period runs for the year: its period moves only when
      // Polar's year starts (a new subscription, a yearly renewal, or a
      // switch to annual that restarted the billing period).
      const incomingBillingEndMs = currentPeriodEnd ? Date.parse(currentPeriodEnd) : null;
      const storedBillingEndMs = stored.billing_period_end
        ? Date.parse(stored.billing_period_end)
        : null;
      const newYear =
        annual &&
        (isNewSubscription ||
          stored.billing_interval !== "year" ||
          (incomingBillingEndMs !== null &&
            (storedBillingEndMs === null || incomingBillingEndMs > storedBillingEndMs)));
      const firstMonthEnd = currentPeriodStart !== null ? addMonthUtc(currentPeriodStart) : null;
      const period = annual
        ? newYear && currentPeriodStart
          ? { period_start: currentPeriodStart, period_end: firstMonthEnd }
          : {}
        : {
            period_start: isStalePeriod ? undefined : currentPeriodStart,
            period_end: isStalePeriod ? undefined : currentPeriodEnd,
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

      // The allowance. A tier up within the period (changePlanForUser's
      // "invoice" change) adds the new plan's extra requests and pages in
      // proportion to what is left of the period, as Polar charged; the
      // window's own requests come back when the period moves on (trigger
      // users_end_plan_proration). Later events in the same window keep it.
      const entitlement = planEntitlements(sold.plan);
      const sameWindow = !resetsUsage && !isStalePeriod;
      let allowance: Database["public"]["Tables"]["users"]["Update"] = {
        request_limit: entitlement.requestLimit,
        prorated_pages: null,
        prorated_window: null,
      };
      if (
        sameWindow &&
        (PLAN_RANK[sold.plan] ?? 0) > (PLAN_RANK[stored.plan] ?? 0) &&
        stored.plan !== "free" &&
        stored.period_start &&
        stored.period_end
      ) {
        const before = planEntitlements(stored.plan);
        // Polar charged for the rest of its own period from the change.
        const changedAt = Math.min(
          Date.parse(String(data.modified_at ?? "")) || Date.now(),
          Date.now()
        );
        const left = remainingShare(
          currentPeriodStart ?? stored.period_start,
          currentPeriodEnd ?? stored.period_end,
          changedAt
        );
        allowance = {
          request_limit:
            before.requestLimit +
            Math.round((entitlement.requestLimit - before.requestLimit) * left),
          prorated_pages:
            before.parsedPages + Math.round((entitlement.parsedPages - before.parsedPages) * left),
          prorated_window: stored.period_start,
        };
      } else if (
        sameWindow &&
        sold.plan === stored.plan &&
        stored.prorated_window !== null &&
        stored.prorated_window === stored.period_start
      ) {
        allowance = {};
      }
      const pending = planForProduct(asNonEmptyString(asRecord(data.pending_update)?.product_id));

      const patch: Database["public"]["Tables"]["users"]["Update"] = {
        polar_customer_id: customerId ?? undefined,
        polar_subscription_id: subscriptionId ?? undefined,
        // An unrecognized status value keeps the stored status instead of
        // nulling it, mirroring the team handler.
        subscription_status:
          normalizeStoredSubscriptionStatus(data.status) ?? stored.subscription_status ?? "active",
        plan: sold.plan,
        ...allowance,
        pending_plan: pending?.plan ?? null,
        pending_interval: pending?.interval ?? null,
        billing_interval: sold.interval,
        billing_period_end: isStalePeriod && !annual ? undefined : currentPeriodEnd,
        ...period,
        cancel_at_period_end:
          typeof data.cancel_at_period_end === "boolean" ? data.cancel_at_period_end : false,
      };

      // Every write is compare-and-swapped on the state that was read. This
      // keeps two failure modes out: overlapping deliveries of the same
      // renewal both zeroing requests_used (erasing usage captured between the
      // writes), and an updated/active event read before a concurrent revoke
      // resurrecting the revoked subscription's state after it. The loser's
      // write matches no rows and throws, so Polar delivers the event again
      // and it is applied to the state that won.
      let guarded = admin
        .from("users")
        .update(resetsUsage ? { ...patch, requests_used: 0 } : patch)
        .eq("id", userId);
      guarded =
        stored.polar_subscription_id === null
          ? guarded.is("polar_subscription_id", null)
          : guarded.eq("polar_subscription_id", stored.polar_subscription_id);
      guarded =
        stored.period_start === null
          ? guarded.is("period_start", null)
          : guarded.eq("period_start", stored.period_start);

      const { data: written, error: guardedError } = await guarded.select("id");
      if (guardedError) throw guardedError;
      if (!written || written.length === 0) {
        throw new Error("The account changed while a plan event was applied; retry it");
      }
      return;
    }

    case "subscription.canceled": {
      const customerId = asNonEmptyString(data.customer_id);
      if (!customerId) return;

      const userId = await findUserIdByPolarCustomerId(customerId);
      if (!userId) return;

      await updateUserForSubscription(userId, asNonEmptyString(data.id), {
        cancel_at_period_end: true,
        subscription_status: "canceled",
      });
      return;
    }

    case "subscription.uncanceled": {
      const customerId = asNonEmptyString(data.customer_id);
      if (!customerId) return;

      const userId = await findUserIdByPolarCustomerId(customerId);
      if (!userId) return;

      await updateUserForSubscription(userId, asNonEmptyString(data.id), {
        cancel_at_period_end: false,
        subscription_status: normalizeStoredSubscriptionStatus(data.status) ?? "active",
      });
      return;
    }

    case "subscription.revoked": {
      const customerId = asNonEmptyString(data.customer_id);
      if (!customerId) return;

      const userId = await findUserIdByPolarCustomerId(customerId);
      if (!userId) return;

      await updateUserForSubscription(userId, asNonEmptyString(data.id), {
        plan: "free",
        subscription_status: null,
        request_limit: FREE_REQUEST_LIMIT,
        requests_used: 0,
        cancel_at_period_end: false,
        period_start: null,
        period_end: null,
        billing_interval: null,
        billing_period_end: null,
        prorated_pages: null,
        prorated_window: null,
        pending_plan: null,
        pending_interval: null,
        polar_subscription_id: null,
        // Recurring blocks and overage need the plan; one-time blocks stay.
        block_requests: 0,
        overage_active: false,
      });
      return;
    }

    case "subscription.active": {
      const customerId = asNonEmptyString(data.customer_id);
      if (!customerId) return;

      const userId = await findUserIdByPolarCustomerId(customerId);
      if (!userId) return;

      await updateUserForSubscription(userId, asNonEmptyString(data.id), {
        subscription_status: "active",
      });
      return;
    }

    default:
      return;
  }
}

export async function processBillingPeriodResets(): Promise<BillingPeriodResetRow> {
  const { data, error } = await callUntypedRpc<BillingPeriodResetRow[]>(
    "process_billing_period_resets"
  );

  if (error) {
    throw new Error(error.message);
  }

  return data?.[0] ?? { processed: 0, downgraded: 0, renewed: 0 };
}

export { BillingActionError };
