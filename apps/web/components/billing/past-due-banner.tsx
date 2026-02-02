"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { AlertTriangle } from "lucide-react";

const POLAR_SUBSCRIPTION_URL = "https://polar.sh/purchases/subscriptions";

export function PastDueBanner() {
  const user = useQuery(api.users.current);

  if (!user || user.subscriptionStatus !== "past_due") return null;

  return (
    <div className="rounded-md bg-destructive/10 border border-destructive/20 p-4 mb-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-destructive">Payment failed</p>
          <p className="text-sm text-muted-foreground">
            We couldn&apos;t process your last payment. Please{" "}
            <a
              href={POLAR_SUBSCRIPTION_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              update your payment method
            </a>{" "}
            to keep your Pro subscription active.
          </p>
        </div>
      </div>
    </div>
  );
}
