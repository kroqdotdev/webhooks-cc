"use client";

import { Notice } from "@/components/settings/panel";
import { planName } from "@/lib/entitlements";

const POLAR_SUBSCRIPTION_URL = "https://polar.sh/purchases/subscriptions";

export function PastDueBanner({
  subscriptionStatus,
  plan,
}: {
  subscriptionStatus: "active" | "canceled" | "past_due" | null;
  plan: string | null;
}) {
  if (subscriptionStatus !== "past_due") return null;

  return (
    <Notice tone="danger" title="Payment failed">
      Your last payment did not go through.{" "}
      <a
        href={POLAR_SUBSCRIPTION_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-foreground"
      >
        Update your payment method
      </a>{" "}
      to keep {planName(plan)}.
    </Notice>
  );
}
