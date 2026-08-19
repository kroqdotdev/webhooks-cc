import { createPolarClient, getPolarCheckoutConfig, unwrapPolarResult } from "@/lib/polar";
import { createAdminClient } from "./admin";
import {
  asNonEmptyString,
  asRecord,
  normalizeStoredSubscriptionStatus,
  parseEventTimestamp,
} from "./billing-shared";
import type { Database } from "./database";

const FREE_REQUEST_LIMIT = 50;
const PRO_REQUEST_LIMIT = 100_000;

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
>;

interface BillingPeriodResetRow {
  processed: number;
  downgraded: number;
  renewed: number;
}

async function getBillingUser(userId: string): Promise<BillingUser> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("users")
    .select("id, email, name, plan, polar_customer_id, polar_subscription_id, cancel_at_period_end")
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

async function ensurePolarCustomerId(user: BillingUser): Promise<string> {
  if (user.polar_customer_id) {
    return user.polar_customer_id;
  }

  const polar = createPolarClient();
  const result = await polar.customers.create({
    email: user.email,
    name: user.name ?? undefined,
    externalId: user.id,
    metadata: {
      userId: user.id,
    },
  });
  const customer = unwrapPolarResult(result, "customer creation");

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

  return customer ? asNonEmptyString(customer.externalId) : null;
}

async function resolveWebhookUserId(data: Record<string, unknown>): Promise<string | null> {
  const explicitUserId = extractCustomerUserId(data);
  if (explicitUserId) {
    return explicitUserId;
  }

  const customerId = asNonEmptyString(data.customerId);
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

export async function createCheckoutForUser(userId: string): Promise<string> {
  const user = await getBillingUser(userId);
  if (user.plan === "pro") {
    throw new BillingActionError("already_pro", "Already on Pro plan");
  }

  const polar = createPolarClient();
  const { appUrl, proProductId } = getPolarCheckoutConfig();
  const customerId = await ensurePolarCustomerId(user);

  const result = await polar.checkouts.create({
    products: [proProductId],
    successUrl: `${appUrl}/account?upgraded=true`,
    customerId,
  });
  const checkout = unwrapPolarResult(result, "checkout creation");

  return checkout.url;
}

export async function cancelSubscriptionForUser(userId: string): Promise<void> {
  const user = await getBillingUser(userId);
  if (!user.polar_subscription_id) {
    throw new BillingActionError("no_subscription", "No active subscription");
  }

  const polar = createPolarClient();
  const result = await polar.subscriptions.update({
    id: user.polar_subscription_id,
    subscriptionUpdate: {
      cancelAtPeriodEnd: true,
    },
  });
  unwrapPolarResult(result, "subscription cancel");

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
  const result = await polar.subscriptions.update({
    id: user.polar_subscription_id,
    subscriptionUpdate: {
      cancelAtPeriodEnd: false,
    },
  });
  unwrapPolarResult(result, "subscription reactivate");

  await updateUserById(user.id, {
    cancel_at_period_end: false,
  });
}

export async function applyPolarWebhookEvent(eventType: string, payload: unknown): Promise<void> {
  const data = asRecord(payload);
  if (!data) {
    return;
  }

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
      const userId = await resolveWebhookUserId(data);
      if (!userId) {
        return;
      }

      const admin = createAdminClient();
      const { data: stored, error: storedError } = await admin
        .from("users")
        .select("polar_subscription_id, subscription_status, period_start")
        .eq("id", userId)
        .maybeSingle<{
          polar_subscription_id: string | null;
          subscription_status: "active" | "canceled" | "past_due" | null;
          period_start: string | null;
        }>();

      if (storedError) throw storedError;
      if (!stored) return;

      const currentPeriodStart = parseEventTimestamp(data.currentPeriodStart);
      const currentPeriodEnd = parseEventTimestamp(data.currentPeriodEnd);
      const customerId = asNonEmptyString(data.customerId);
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

      const patch: Database["public"]["Tables"]["users"]["Update"] = {
        polar_customer_id: customerId ?? undefined,
        polar_subscription_id: subscriptionId ?? undefined,
        // An unrecognized status value keeps the stored status instead of
        // nulling it, mirroring the team handler.
        subscription_status:
          normalizeStoredSubscriptionStatus(data.status) ?? stored.subscription_status ?? "active",
        plan: "pro",
        request_limit: PRO_REQUEST_LIMIT,
        period_start: isStalePeriod ? undefined : currentPeriodStart,
        period_end: isStalePeriod ? undefined : currentPeriodEnd,
        cancel_at_period_end:
          typeof data.cancelAtPeriodEnd === "boolean" ? data.cancelAtPeriodEnd : false,
      };

      // Every write is compare-and-swapped on the state that was read. This
      // keeps two failure modes out: overlapping deliveries of the same
      // renewal both zeroing requests_used (erasing usage captured between the
      // writes), and an updated/active event read before a concurrent revoke
      // resurrecting the revoked subscription's state after it. The loser's
      // write matches no rows; events carry full state and Polar redelivers,
      // so a skipped write converges on the next delivery.
      let guarded = admin
        .from("users")
        .update(isNewSubscription || isRenewal ? { ...patch, requests_used: 0 } : patch)
        .eq("id", userId);
      guarded =
        stored.polar_subscription_id === null
          ? guarded.is("polar_subscription_id", null)
          : guarded.eq("polar_subscription_id", stored.polar_subscription_id);
      guarded =
        stored.period_start === null
          ? guarded.is("period_start", null)
          : guarded.eq("period_start", stored.period_start);

      const { error: guardedError } = await guarded;
      if (guardedError) throw guardedError;
      return;
    }

    case "subscription.canceled": {
      const customerId = asNonEmptyString(data.customerId);
      if (!customerId) return;

      const userId = await findUserIdByPolarCustomerId(customerId);
      if (!userId) return;

      await updateUserById(userId, {
        cancel_at_period_end: true,
        subscription_status: "canceled",
      });
      return;
    }

    case "subscription.uncanceled": {
      const customerId = asNonEmptyString(data.customerId);
      if (!customerId) return;

      const userId = await findUserIdByPolarCustomerId(customerId);
      if (!userId) return;

      await updateUserById(userId, {
        cancel_at_period_end: false,
        subscription_status: normalizeStoredSubscriptionStatus(data.status) ?? "active",
      });
      return;
    }

    case "subscription.revoked": {
      const customerId = asNonEmptyString(data.customerId);
      if (!customerId) return;

      const userId = await findUserIdByPolarCustomerId(customerId);
      if (!userId) return;

      await updateUserById(userId, {
        plan: "free",
        subscription_status: null,
        request_limit: FREE_REQUEST_LIMIT,
        requests_used: 0,
        cancel_at_period_end: false,
        period_start: null,
        period_end: null,
        polar_subscription_id: null,
      });
      return;
    }

    case "subscription.active": {
      const customerId = asNonEmptyString(data.customerId);
      if (!customerId) return;

      const userId = await findUserIdByPolarCustomerId(customerId);
      if (!userId) return;

      await updateUserById(userId, {
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
