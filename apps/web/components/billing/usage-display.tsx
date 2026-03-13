"use client";

import { useEffect, useRef } from "react";
import type { AccountProfile } from "@/lib/account-profile";
import { trackQuotaWarningShown } from "@/lib/analytics";

export function UsageDisplay({ profile }: { profile: AccountProfile | null }) {
  const warningFired = useRef(false);

  const percentage =
    profile && profile.request_limit > 0
      ? Math.min((profile.requests_used / profile.request_limit) * 100, 100)
      : 0;
  const isNearLimit = percentage > 80;

  useEffect(() => {
    if (profile && isNearLimit && !warningFired.current) {
      warningFired.current = true;
      trackQuotaWarningShown(profile.plan, percentage);
    }
  }, [profile, isNearLimit, percentage]);

  if (profile === null) {
    return (
      <div className="space-y-2 animate-pulse">
        <div className="flex justify-between">
          <div className="h-4 w-24 bg-muted rounded" />
          <div className="h-4 w-16 bg-muted rounded" />
        </div>
        <div className="h-2 bg-muted rounded-full" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <span>{profile.plan === "free" ? "Requests today" : "Requests this period"}</span>
        <span className={isNearLimit ? "text-destructive font-medium" : "font-medium"}>
          {profile.requests_used.toLocaleString()} / {profile.request_limit.toLocaleString()}
        </span>
      </div>
      <div
        className="h-2 bg-muted rounded-full overflow-hidden"
        role="progressbar"
        aria-valuenow={percentage}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Usage: ${profile.requests_used.toLocaleString()} of ${profile.request_limit.toLocaleString()} requests`}
      >
        <div
          className={`h-full transition-all ${isNearLimit ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      {profile.period_end && (
        <p className="text-xs text-muted-foreground">
          Resets {new Date(profile.period_end).toLocaleDateString()}
        </p>
      )}
    </div>
  );
}
