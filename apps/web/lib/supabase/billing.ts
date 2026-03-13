import { createPolarClient, getPolarCheckoutConfig, unwrapPolarResult } from "@/lib/polar";
import { createAdminClient } from "./admin";
import type { Database } from "./database";

const FREE_REQUEST_LIMIT = 50;
const PRO_REQUEST_LIMIT = 100_000;

type UserRow = Database["public"]["Tables"]["users"]["Row"];
type StoredSubscriptionStatus = UserRow["subscription_status"];

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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeStoredSubscriptionStatus(status: unknown): StoredSubscriptionStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "canceled":
      return "canceled";
    case "past_due":
    case "incomplete":
    case "incomplete_expired":
    case "unpaid":
      return "past_due";
    default:
      return null;
  }
}

function parseEventTimestamp(value: unknown): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return null;
  }

  return value.toISOString();
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
    throw new BillingActionError(
      "not_scheduled",
      "Subscription is not scheduled for cancellation"
    );
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

      const currentPeriodStart = parseEventTimestamp(data.currentPeriodStart);
      const currentPeriodEnd = parseEventTimestamp(data.currentPeriodEnd);
      const customerId = asNonEmptyString(data.customerId);
      const subscriptionId = asNonEmptyString(data.id);

      await updateUserById(userId, {
        polar_customer_id: customerId ?? undefined,
        polar_subscription_id: subscriptionId ?? undefined,
        subscription_status: normalizeStoredSubscriptionStatus(data.status),
        plan: "pro",
        request_limit: PRO_REQUEST_LIMIT,
        period_start: currentPeriodStart,
        period_end: currentPeriodEnd,
        cancel_at_period_end:
          typeof data.cancelAtPeriodEnd === "boolean" ? data.cancelAtPeriodEnd : false,
      });
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

export { BillingActionError };
