"use client";

import { BillingPortalLink } from "@/components/billing/billing-portal";
import { Notice } from "@/components/settings/panel";
import { planName } from "@/lib/entitlements";

export function PastDueBanner({
  subscriptionStatus,
  plan,
  accessToken,
}: {
  subscriptionStatus: "active" | "canceled" | "past_due" | null;
  plan: string | null;
  accessToken: string | null;
}) {
  if (subscriptionStatus !== "past_due") return null;

  return (
    <Notice tone="danger" title="Payment failed">
      Your last payment did not go through.{" "}
      <BillingPortalLink accessToken={accessToken}>Update your payment method</BillingPortalLink> to
      keep {planName(plan)}.
    </Notice>
  );
}
