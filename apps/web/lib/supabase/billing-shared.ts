import { createPolarClient, isEndedSubscriptionError, loggablePolarError } from "@/lib/polar";
import { reportError } from "@/lib/observability";
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
 * dashboard's routes answer only its url; a checkout link
 * (lib/billing/checkout-links.ts) records its id and expiry and sends the
 * person on to the url. id is null only for a team's open session cached
 * before ids were stored.
 */
export interface CheckoutSession {
  id: string | null;
  url: string;
  expiresAt: string | null;
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

/**
 * What a checkout link's Polar session buys: the product and, where the
 * product sells a quantity, the seats or units. A paid link's order or
 * subscription is compared with it (`matches`).
 */
export interface CheckoutExpected {
  product: string;
  seats?: number;
  units?: number;
}

/** The checkout link a Polar session is made for. */
export interface CheckoutLinkContext {
  /** The link's id: the session's metadata names it (`checkout_link`). */
  id: string;
  /** Where Polar sends the person after paying. */
  successUrl: string;
}

/** The metadata key naming the checkout link a Polar session was made for. */
export const CHECKOUT_LINK_METADATA_KEY = "checkout_link";

/**
 * A purchase a checkout link may make, checked: what its session buys, and
 * how to make the session. The checks (who may buy, what the account has)
 * run when the purchase is made, so a link is refused at once when it could
 * not be bought, and checked again when the person opens it, since the
 * account may have changed meanwhile. mint() makes the Polar session (and
 * the Polar customer when there is none yet); nothing in Polar is touched
 * before it.
 */
export interface LinkPurchase {
  expected: CheckoutExpected;
  mint(link: CheckoutLinkContext): Promise<CheckoutSession>;
}

/** The Polar subscription statuses that still bill and give access. */
export const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "past_due",
]);

/** A subscription record (Polar's current state) that is live and has not ended. */
export function isLiveSubscriptionState(subscription: Record<string, unknown> | null): boolean {
  return (
    subscription !== null &&
    LIVE_SUBSCRIPTION_STATUSES.has(String(subscription.status)) &&
    asNonEmptyString(subscription.ended_at) === null
  );
}

/**
 * Whether the subscription is live as Polar has it now. Polar's errors
 * propagate, so the event is delivered again later.
 */
export async function isLiveSubscription(id: string): Promise<boolean> {
  return isLiveSubscriptionState(asRecord(await createPolarClient().subscriptions.get(id)));
}

/** When a Polar subscription started (else was created), in ms; null when Polar left both out. */
export function subscriptionStartMs(subscription: Record<string, unknown>): number | null {
  const value =
    asNonEmptyString(subscription.started_at) ?? asNonEmptyString(subscription.created_at);
  const ms = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * How close two subscriptions' starts must be to count as twin checkouts:
 * a Polar checkout session lives one hour, so two sessions open at once are
 * paid at most that far apart; two hours leaves room for a slow payment.
 */
export const TWIN_CHECKOUT_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * What to do with a second live plan subscription (`event`) beside the one
 * the account or team holds (`stored`). "end" (refund and revoke it) when it
 * started after the stored one, or within TWIN_CHECKOUT_WINDOW_MS of it
 * either way: two sessions paid together, whose events may arrive in either
 * order (a 5xx retry delivers the first one's late), so the one that arrives
 * second is the extra one. "report" for a person otherwise, or when Polar
 * left out when either started: one that started well before may be the plan
 * used all along (its row cleared by a revoked event while it stayed live),
 * and a full refund would pay back months that were used.
 */
export function duplicateVerdict(
  event: Record<string, unknown>,
  stored: Record<string, unknown>
): "end" | "report" {
  const started = subscriptionStartMs(event);
  const storedStarted = subscriptionStartMs(stored);
  if (started === null || storedStarted === null) return "report";
  if (started > storedStarted) return "end";
  return storedStarted - started <= TWIN_CHECKOUT_WINDOW_MS ? "end" : "report";
}

/** Revokes a subscription; one an earlier delivery already ended is fine. */
export async function revokeSubscriptionQuietly(id: string): Promise<void> {
  try {
    await createPolarClient().subscriptions.revoke(id);
  } catch (error) {
    // Revoked by an earlier delivery of the same event.
    if (isEndedSubscriptionError(error)) return;
    reportError("[billing] could not revoke a subscription", loggablePolarError(error), {
      subscriptionId: id,
    });
    throw error;
  }
}
