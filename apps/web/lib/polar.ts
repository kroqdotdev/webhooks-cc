import { PolarError, PolarNetworkError } from "@polar-sh/sdk";
import { createPolar, type Polar } from "@polar-sh/sdk/2026-10";
import { publicEnv } from "./env";

class PolarConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarConfigError";
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new PolarConfigError(`${name} is not configured`);
  }
  return value;
}

export function createPolarClient(): Polar {
  const accessToken = requireEnv("POLAR_ACCESS_TOKEN");

  return createPolar({
    accessToken,
    environment: process.env.POLAR_SANDBOX === "true" ? "sandbox" : "production",
    // The SDK gives up after 5 seconds by default and nothing retries, so a
    // slow Polar response would fail a checkout or seat charge that Polar
    // still completes. Stays under the 60 second checkout lease.
    timeout: 30,
  });
}

export function getPolarCheckoutConfig() {
  return {
    appUrl: publicEnv().NEXT_PUBLIC_APP_URL,
    proProductId: requireEnv("POLAR_PRO_PRODUCT_ID"),
  };
}

export function getPolarTeamsCheckoutConfig() {
  return {
    appUrl: publicEnv().NEXT_PUBLIC_APP_URL,
    teamsProductId: requireEnv("POLAR_TEAMS_PRODUCT_ID"),
  };
}

/** Polar products for extra request capacity (lib/capacity.ts). */
export interface CapacityProductIds {
  /** One-time blocks, unit-priced. */
  oneTime: string;
  /** Recurring blocks, a monthly unit-priced subscription. */
  monthly: string;
  /** Recurring blocks added mid-period: a one-time order at the monthly price. */
  monthlyAdd: string;
  /** Overage, a monthly subscription with only a metered price. */
  overage: string;
}

/** Each add-on product id that is set, whether or not the others are. */
export function configuredCapacityProductIds(): Partial<CapacityProductIds> {
  return {
    oneTime: process.env.POLAR_REQUEST_BLOCKS_PRODUCT_ID || undefined,
    monthly: process.env.POLAR_MONTHLY_BLOCKS_PRODUCT_ID || undefined,
    monthlyAdd: process.env.POLAR_MONTHLY_BLOCKS_ADD_PRODUCT_ID || undefined,
    overage: process.env.POLAR_OVERAGE_PRODUCT_ID || undefined,
  };
}

/**
 * The add-on products, or null while any of them is unset: extra capacity is
 * offered only once all four exist, so the product never half-works. Webhook
 * routing matches each set id on its own (configuredCapacityProductIds()).
 */
export function getCapacityProductIds(): CapacityProductIds | null {
  const { oneTime, monthly, monthlyAdd, overage } = configuredCapacityProductIds();
  if (!oneTime || !monthly || !monthlyAdd || !overage) return null;
  return { oneTime, monthly, monthlyAdd, overage };
}

/** Each parsed-page add-on product id that is set. */
export function configuredPageProductIds(): Partial<CapacityProductIds> {
  return {
    oneTime: process.env.POLAR_PAGE_BLOCKS_PRODUCT_ID || undefined,
    monthly: process.env.POLAR_MONTHLY_PAGE_BLOCKS_PRODUCT_ID || undefined,
    monthlyAdd: process.env.POLAR_MONTHLY_PAGE_BLOCKS_ADD_PRODUCT_ID || undefined,
    overage: process.env.POLAR_PAGE_OVERAGE_PRODUCT_ID || undefined,
  };
}

/** The parsed-page add-on products, or null while any of them is unset. */
export function getPageProductIds(): CapacityProductIds | null {
  const { oneTime, monthly, monthlyAdd, overage } = configuredPageProductIds();
  if (!oneTime || !monthly || !monthlyAdd || !overage) return null;
  return { oneTime, monthly, monthlyAdd, overage };
}

/** The Team Business add-on product, or null when it is not offered. */
export function teamBusinessProductId(): string | null {
  return process.env.POLAR_TEAM_BUSINESS_PRODUCT_ID || null;
}

export type PaidPlan = "pro" | "business";
export type BillingInterval = "month" | "year";

/** The Polar product of a plan and interval, or null when it is not offered. */
export function planProductId(plan: PaidPlan, interval: BillingInterval): string | null {
  if (plan === "pro") return interval === "month" ? process.env.POLAR_PRO_PRODUCT_ID || null : null;
  return interval === "year"
    ? process.env.POLAR_BUSINESS_ANNUAL_PRODUCT_ID || null
    : process.env.POLAR_BUSINESS_PRODUCT_ID || null;
}

/**
 * The plan and interval a Polar product sells, or null for any other
 * product. The Pro product id is required; the Business ones are optional.
 */
export function planForProduct(
  productId: string | null | undefined
): { plan: PaidPlan; interval: BillingInterval } | null {
  if (!productId) return null;
  if (productId === process.env.POLAR_PRO_PRODUCT_ID) return { plan: "pro", interval: "month" };
  if (productId === process.env.POLAR_BUSINESS_PRODUCT_ID) {
    return { plan: "business", interval: "month" };
  }
  if (productId === process.env.POLAR_BUSINESS_ANNUAL_PRODUCT_ID) {
    return { plan: "business", interval: "year" };
  }
  return null;
}

export function getPolarWebhookSecret(): string {
  return requireEnv("POLAR_WEBHOOK_SECRET");
}

function truncateDetail(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
}

function messagesFromValidationDetail(detail: unknown): string | null {
  if (!Array.isArray(detail)) return null;

  const messages = detail
    .map((entry) => (entry && typeof entry === "object" ? (entry as { msg?: unknown }).msg : null))
    .filter((msg): msg is string => typeof msg === "string" && msg.length > 0);

  return messages.length > 0 ? truncateDetail(messages.join("; ")) : null;
}

/**
 * The parsed error body of a Polar client error: an object when the endpoint
 * declares that status code, otherwise the raw response text, which is JSON
 * for every 4xx Polar sends.
 */
function polarErrorPayload(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null;

  const payload = (error as { error?: unknown }).error;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  if (typeof payload === "string" && payload.length > 0) {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON body: not safe to surface.
    }
  }
  return null;
}

/**
 * The machine-readable error code Polar put in the body, such as
 * `SeatNotAvailable` or `PaymentFailed`, or null.
 */
export function polarErrorCode(error: unknown): string | null {
  const code = polarErrorPayload(error)?.error;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/**
 * Extracts a short human-readable description from a Polar SDK error, or null
 * when there is nothing better than the generic message. Lets routes surface
 * validation detail (e.g. Polar rejecting an unroutable billing email) without
 * leaking raw response bodies. Polar 4xx bodies are JSON like
 * {"detail": "..."}, FastAPI-style {"detail": [{loc, msg, type}]}, or
 * {"error": "...", "error_description": "..."}.
 */
export function describePolarError(error: unknown): string | null {
  const payload = polarErrorPayload(error);
  if (!payload) return null;

  if (typeof payload.detail === "string" && payload.detail.length > 0) {
    return truncateDetail(payload.detail);
  }
  const fromDetail = messagesFromValidationDetail(payload.detail);
  if (fromDetail) return fromDetail;
  if (typeof payload.error_description === "string" && payload.error_description.length > 0) {
    return truncateDetail(payload.error_description);
  }

  return null;
}

export { PolarConfigError };

/**
 * True when Polar refused a change because the subscription has already
 * ended: the change has nothing left to act on. A 404 is not taken as ended,
 * because a misconfigured token would look the same while a real
 * subscription keeps charging.
 */
export function isEndedSubscriptionError(error: unknown): boolean {
  // Polar answers 403 with this code for a subscription that already ended.
  if (polarErrorCode(error) === "AlreadyCanceledSubscription") return true;

  // Fallback for other wordings, from the Polar detail and the message.
  const haystack = [describePolarError(error), error instanceof Error ? error.message : null]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
  return /already[\s_-]?(canceled|cancelled|revoked)/i.test(haystack);
}

/**
 * Reduces a Polar SDK error to the parts that are safe to log. The message of
 * an HTTP error embeds the whole response body, which can echo request input
 * such as an email address, so only network errors keep theirs. Non-Polar
 * errors pass through unchanged, so Supabase/Postgres errors keep their
 * code/details/hint.
 */
export function loggablePolarError(error: unknown): unknown {
  if (!(error instanceof PolarError)) return error;

  const statusCode = "statusCode" in error ? error.statusCode : null;
  return {
    name: error.name,
    statusCode: typeof statusCode === "number" ? statusCode : null,
    code: polarErrorCode(error),
    detail: describePolarError(error),
    message: error instanceof PolarNetworkError ? error.message : undefined,
  };
}
