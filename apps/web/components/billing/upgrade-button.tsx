"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";

export function UpgradeButton() {
  const createCheckout = useAction(api.billing.createCheckout);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpgrade = async () => {
    setLoading(true);
    setError(null);
    try {
      const url = await createCheckout();
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
      <Button onClick={handleUpgrade} disabled={loading}>
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
