import {
  captureServerEvent,
  serverAnalyticsEnabled,
  stableEventUuid,
} from "@/lib/analytics-server";
import { planForProduct } from "@/lib/polar";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveWebhookUserId } from "@/lib/supabase/billing";
import { capacityProductKind, webhookProductId } from "@/lib/supabase/capacity-billing";

/**
 * Billing events for product analytics, from applied Polar webhooks: what was
 * bought, and when a subscription starts, is cancelled or ends. Orders carry
 * `revenue` (in the currency's major unit, before tax) and `currency`, which
 * PostHog's revenue analytics reads. A team's events go to the person who
 * created the team, with the team as their group.
 */

const SUBSCRIPTION_EVENTS: Record<string, string> = {
  "subscription.active": "subscription_started",
  "subscription.canceled": "subscription_canceled",
  "subscription.uncanceled": "subscription_uncanceled",
  "subscription.revoked": "subscription_ended",
};

/** What a Polar product is, in words analytics can group by. */
export function analyticsProduct(productId: string | null, teamId: string | null): string {
  const plan = planForProduct(productId);
  if (plan) return `${plan.plan}_${plan.interval}`;
  const capacity = capacityProductKind(productId);
  if (capacity) return `${capacity.resource}_${capacity.kind}`;
  return teamId ? "team_seats" : "unknown";
}

function amountOf(data: Record<string, unknown>): number | null {
  for (const key of ["net_amount", "total_amount"]) {
    const value = data[key];
    if (typeof value === "number" && Number.isFinite(value)) return value / 100;
  }
  return null;
}

export function billingAnalyticsEvent(
  eventType: string,
  teamId: string | null,
  data: Record<string, unknown>
): { event: string; properties: Record<string, unknown> } | null {
  const product = analyticsProduct(webhookProductId(data), teamId);
  const account_kind = teamId ? "team" : "user";
  if (eventType === "order.paid") {
    const revenue = amountOf(data);
    if (revenue === null) return null;
    return {
      event: "order_paid",
      properties: {
        revenue,
        currency: typeof data.currency === "string" ? data.currency.toUpperCase() : "USD",
        billing_reason: typeof data.billing_reason === "string" ? data.billing_reason : null,
        product,
        account_kind,
      },
    };
  }
  const event = SUBSCRIPTION_EVENTS[eventType];
  if (!event) return null;
  return { event, properties: { product, account_kind } };
}

async function teamCreator(teamId: string): Promise<string | null> {
  const { data } = await createAdminClient()
    .from("teams")
    .select("created_by")
    .eq("id", teamId)
    .maybeSingle();
  return data?.created_by ?? null;
}

/** Sends the analytics event for a Polar webhook that was applied; never throws. */
export async function captureBillingEvent(input: {
  eventType: string;
  teamId: string | null;
  data: Record<string, unknown>;
  /** Polar's webhook-id header, so a redelivery is the same event. */
  webhookId: string | null;
}): Promise<void> {
  if (!serverAnalyticsEnabled()) return;
  const mapped = billingAnalyticsEvent(input.eventType, input.teamId, input.data);
  if (!mapped) return;
  try {
    const distinctId = input.teamId
      ? await teamCreator(input.teamId)
      : await resolveWebhookUserId(input.data);
    if (!distinctId) return;
    captureServerEvent({
      distinctId,
      event: mapped.event,
      properties: mapped.properties,
      groups: input.teamId ? { team: input.teamId } : undefined,
      uuid: input.webhookId ? stableEventUuid(`polar:${input.webhookId}`) : undefined,
    });
  } catch (error) {
    console.warn(
      "[analytics] billing event skipped:",
      error instanceof Error ? error.message : error
    );
  }
}
