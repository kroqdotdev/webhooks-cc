import type { Database } from "./database";

/**
 * Helpers shared by the personal (`billing.ts`) and team (`team-billing.ts`)
 * Polar integrations. Both consume the same webhook payload shapes, so the
 * parsing/normalization rules must stay identical between them.
 */

type UserRow = Database["public"]["Tables"]["users"]["Row"];

/** The subscription status vocabulary stored on `users` and `teams`. */
export type StoredSubscriptionStatus = UserRow["subscription_status"];

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeStoredSubscriptionStatus(status: unknown): StoredSubscriptionStatus {
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

/**
 * Normalizes a Polar timestamp to the ISO string we store, or null when it is
 * missing or invalid. Webhook payloads and API responses carry ISO 8601
 * strings with microseconds; they are truncated to milliseconds so stored
 * values compare consistently (`pending_seats_as_of` ordering relies on it).
 */
export function parseEventTimestamp(value: unknown): string | null {
  const ms =
    value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * A Polar checkout session as the checkout creators return it: the
 * dashboard's routes answer only its url, checkout links (lib/billing/
 * checkout-links.ts) record its id and expiry too. id is null only for a
 * team's open session cached before ids were stored.
 */
export interface CheckoutSession {
  id: string | null;
  url: string;
  expiresAt: string | null;
}

/** How a checkout creator may be asked to differ from the dashboard's. */
export interface CheckoutOptions {
  /** Where Polar sends the person after paying, instead of the dashboard page. */
  successUrl?: string;
}

export function checkoutSession(checkout: {
  id: string;
  url: string;
  expires_at?: unknown;
}): CheckoutSession {
  return {
    id: checkout.id,
    url: checkout.url,
    expiresAt: parseEventTimestamp(checkout.expires_at),
  };
}
