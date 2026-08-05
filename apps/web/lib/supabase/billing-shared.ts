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

export function parseEventTimestamp(value: unknown): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return null;
  }

  return value.toISOString();
}
