"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { OctagonAlert } from "lucide-react";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { UpgradeButton } from "@/components/billing/upgrade-button";
import { ACCOUNT_PROFILE_SELECT, type AccountProfile } from "@/lib/account-profile";
import { isQuotaExhausted } from "@/lib/quota";
import { createClient } from "@/lib/supabase/client";
import { subscribeToUserRow } from "@/lib/supabase/realtime";

/**
 * Shown while the receiver is rejecting the user's webhooks with 429. Without
 * it a capped user only sees captures stop arriving; usage lives on /account.
 * Endpoints shared with a subscribed team bill to the team and keep capturing,
 * so the copy names them as unaffected when the user has any.
 */
export function QuotaBanner() {
  const { user, session } = useAuth();
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [teamBilledEndpoints, setTeamBilledEndpoints] = useState(0);
  const userId = user?.id;
  const accessToken = session?.access_token ?? null;

  useEffect(() => {
    if (!userId) {
      setProfile(null);
      return;
    }

    let cancelled = false;
    void createClient()
      .from("users")
      .select(ACCOUNT_PROFILE_SELECT)
      .eq("id", userId)
      .single<AccountProfile>()
      .then(({ data }) => {
        if (!cancelled) setProfile(data ?? null);
      });

    const unsubscribe = subscribeToUserRow(userId, (row) => {
      setProfile(row ? (row as AccountProfile) : null);
      setNowMs(Date.now());
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userId]);

  const exhausted = isQuotaExhausted(profile, nowMs);
  const periodEnd = profile?.period_end ?? null;

  // team_endpoints is not readable by clients, so ask the usage route.
  useEffect(() => {
    if (!exhausted || !accessToken) return;
    let cancelled = false;
    void fetch("/api/usage", { headers: { Authorization: `Bearer ${accessToken}` } })
      .then((response) => (response.ok ? response.json() : null))
      .then((usage: { teamBilledEndpoints?: number } | null) => {
        if (!cancelled) setTeamBilledEndpoints(usage?.teamBilledEndpoints ?? 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [exhausted, accessToken]);

  // Hide the banner when the period resets, even if no row update arrives.
  useEffect(() => {
    if (!exhausted || !periodEnd) return;
    const delay = Math.max(new Date(periodEnd).getTime() - Date.now(), 0);
    const timer = setTimeout(() => setNowMs(Date.now()), Math.min(delay + 1000, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [exhausted, periodEnd]);

  if (!profile || !exhausted || !periodEnd) return null;

  const isFree = profile.plan === "free";
  const resetsAt = new Date(periodEnd).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="bg-card border-b-strong border-destructive px-4 py-3" role="status">
      <div className="flex flex-wrap items-center gap-3">
        <OctagonAlert className="h-5 w-5 text-destructive flex-shrink-0" />
        <div className="flex-1 min-w-64 space-y-1">
          <p className="text-sm font-medium">
            <span className="font-bold">Request limit reached.</span> You have used all{" "}
            {profile.request_limit.toLocaleString()} requests in this period. New webhooks to your
            endpoints are rejected with HTTP 429 until {resetsAt}.
            {teamBilledEndpoints > 0 &&
              " Endpoints shared with a team use the team's quota and keep capturing."}
          </p>
          <p className="text-sm text-muted-foreground">
            {isFree
              ? "Pro raises the limit to 100,000 requests a month for $8/month. "
              : "Your Pro quota is used up for this period. "}
            Capturing for a company?{" "}
            <Link href="/teams" className="underline font-medium text-foreground hover:opacity-80">
              Start a team
            </Link>{" "}
            for a pooled quota of 100,000 requests per seat.
          </p>
        </div>
        {isFree && <UpgradeButton accessToken={accessToken} />}
      </div>
    </div>
  );
}
