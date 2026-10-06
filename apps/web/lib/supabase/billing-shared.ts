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
