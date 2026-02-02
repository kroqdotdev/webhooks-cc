"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";

export function UsageDisplay() {
  const user = useQuery(api.users.current);

  if (user === undefined) {
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

  if (user === null) return null;

  const percentage =
    user.requestLimit > 0 ? Math.min((user.requestsUsed / user.requestLimit) * 100, 100) : 0;
  const isNearLimit = percentage > 80;

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <span>{user.plan === "free" ? "Requests today" : "Requests this period"}</span>
        <span className={isNearLimit ? "text-destructive font-medium" : "font-medium"}>
          {user.requestsUsed.toLocaleString()} / {user.requestLimit.toLocaleString()}
        </span>
      </div>
      <div
        className="h-2 bg-muted rounded-full overflow-hidden"
        role="progressbar"
        aria-valuenow={percentage}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Usage: ${user.requestsUsed.toLocaleString()} of ${user.requestLimit.toLocaleString()} requests`}
      >
        <div
          className={`h-full transition-all ${isNearLimit ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      {user.periodEnd && (
        <p className="text-xs text-muted-foreground">
          Resets {new Date(user.periodEnd).toLocaleDateString()}
        </p>
      )}
    </div>
  );
}
