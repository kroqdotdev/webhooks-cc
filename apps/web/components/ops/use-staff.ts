"use client";

import { useEffect, useState } from "react";

export interface StaffStatus {
  staff: boolean;
  /** The session passed two-factor sign-in. */
  aal2: boolean;
  /** The account has an authenticator app set up. */
  hasFactor: boolean;
  /** Tickets waiting on support, when known. */
  waiting: number | null;
  /** Open reports of shared previews, when known (absent from older answers). */
  reports?: number | null;
}

const CACHE_KEY = "whk-staff";

/**
 * Whether the signed-in person is staff, asked once per browser tab and
 * remembered for the tab: most people are not, and the answer is the same
 * 404 every ops route gives them.
 */
export function useStaff(
  userId: string | null,
  token: string | null,
  /** False until the answer is needed, so most pages never ask. */
  enabled = true
): StaffStatus | null {
  const [status, setStatus] = useState<{ userId: string; value: StaffStatus } | null>(null);

  useEffect(() => {
    if (!userId || !token || !enabled) return;
    let cancelled = false;
    try {
      const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? "null") as {
        userId: string;
        staff: boolean;
      } | null;
      if (cached?.userId === userId && !cached.staff) {
        setStatus({
          userId,
          value: { staff: false, aal2: false, hasFactor: false, waiting: null },
        });
        return;
      }
    } catch {
      // Ask again.
    }
    void fetch("/api/ops/me", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        // Read the body either way, so a 404 does not leave the response open.
        const body = (await response.json().catch(() => null)) as StaffStatus | null;
        // An unreadable success says nothing about staff status: leave it unset
        // and uncached, so a later mount asks again.
        if (response.ok && !body) return;
        const value: StaffStatus =
          response.ok && body
            ? body
            : { staff: false, aal2: false, hasFactor: false, waiting: null };
        if (cancelled) return;
        setStatus({ userId, value });
        try {
          sessionStorage.setItem(CACHE_KEY, JSON.stringify({ userId, staff: value.staff }));
        } catch {
          // Not remembered.
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [userId, token, enabled]);

  if (!userId) return null;
  return status?.userId === userId ? status.value : null;
}
