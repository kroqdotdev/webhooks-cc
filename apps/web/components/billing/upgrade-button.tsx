"use client";

import { useState } from "react";
import { createBillingCheckout } from "@/lib/billing-api";
import { Button } from "@/components/ui/button";
import { trackUpgradeClicked } from "@/lib/analytics";

export function UpgradeButton({ accessToken }: { accessToken: string | null }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpgrade = async () => {
    if (!accessToken) {
      setError("Your session expired. Please sign in again.");
      return;
    }

    setLoading(true);
    setError(null);
    trackUpgradeClicked();
    try {
      const url = await createBillingCheckout(accessToken);
      // Set a timeout to reset if redirect doesn't happen (e.g., popup blocker)
      setTimeout(() => {
        setLoading(false);
        setError("Redirect failed. Please try again or check your popup blocker.");
      }, 5000);
      window.location.href = url;
    } catch (err) {
      console.error("Upgrade error:", err);
      setError("Failed to start checkout. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div>
      <Button onClick={handleUpgrade} disabled={loading || !accessToken}>
        {loading ? "Redirecting..." : "Upgrade to Pro"}
      </Button>
      {error && (
        <p className="text-sm text-destructive mt-2" role="alert" aria-live="polite">
          {error}
        </p>
      )}
    </div>
  );
}
