"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { ACCOUNT_PROFILE_SELECT, type AccountProfile } from "@/lib/account-profile";
import { identifyUser } from "@/lib/analytics";
import { createClient } from "@/lib/supabase/client";
import { subscribeToUserProfileChanges } from "@/lib/supabase/realtime";
import type { AllowanceUsage } from "@/lib/supabase/allowance-usage";

const USAGE_REFRESH_INTERVAL_MS = 30_000;

/**
 * The signed-in user's row. With `live`, it also follows plan, billing and
 * quota-state signals and re-reads the usage counter on an interval while the
 * page is visible, because the counter moves on every capture without a signal.
 */
export function useAccountProfile({ live = false }: { live?: boolean } = {}) {
  const { user: authUser, session } = useAuth();
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  /** Emails among this period's requests (from /api/usage); null until known. */
  const [periodEmails, setPeriodEmails] = useState<number | null>(null);
  /** The plan's other allowances (from /api/usage); null until known. */
  const [allowances, setAllowances] = useState<AllowanceUsage | null>(null);
  // Refreshes overlap (interval, focus, signals): only the newest usage read applies.
  const usageRead = useRef(0);
  const [loading, setLoading] = useState(true);
  const accessToken = session?.access_token ?? null;

  const refresh = useCallback(async () => {
    if (!authUser) {
      setProfile(null);
      setLoading(false);
      return;
    }

    const supabase = createClient();
    const { data, error } = await supabase
      .from("users")
      .select(ACCOUNT_PROFILE_SELECT)
      .eq("id", authUser.id)
      .single<AccountProfile>();

    if (error) console.error("Failed to fetch user profile:", error);
    setProfile(data ?? null);
    setLoading(false);

    if (live && accessToken) {
      const read = ++usageRead.current;
      void fetch("/api/usage", { headers: { Authorization: `Bearer ${accessToken}` } })
        .then((res) =>
          res.ok ? (res.json() as Promise<Partial<AllowanceUsage> & { emails?: number }>) : null
        )
        .then((usage) => {
          if (read !== usageRead.current) return;
          setPeriodEmails(typeof usage?.emails === "number" ? usage.emails : null);
          // A failed read keeps what is shown rather than blanking the meters.
          if (usage) {
            setAllowances({
              parsedPages: usage.parsedPages ?? null,
              previewData: usage.previewData ?? null,
              aiAssists: usage.aiAssists ?? null,
            });
          }
        })
        .catch(() => {
          if (read === usageRead.current) setPeriodEmails(null);
        });
    }

    if (data) {
      // Does nothing until the visitor accepts analytics (lib/analytics.ts).
      identifyUser(authUser.id, {
        plan: data.plan,
        request_limit: data.request_limit,
      });
    }
  }, [authUser, accessToken, live]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!live || !authUser) return;

    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const interval = setInterval(refreshIfVisible, USAGE_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    const unsubscribe = subscribeToUserProfileChanges(authUser.id, () => void refresh());

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      unsubscribe();
    };
  }, [live, authUser, refresh]);

  return {
    profile,
    setProfile,
    periodEmails,
    allowances,
    loading,
    refresh,
    accessToken,
    authUser,
  };
}
