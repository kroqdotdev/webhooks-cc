"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  claimGuestEndpointForUser,
  fetchDashboardEndpoints,
  subscribeDashboardEndpointsChanged,
  type DashboardEndpointsResponse,
} from "@/lib/dashboard-api";
import {
  createEndpointsLoader,
  type DashboardEndpointsState,
} from "@/lib/dashboard-endpoints-loader";

interface DashboardEndpointsValue {
  /** The account's endpoints, its own and those shared with it; undefined until a load succeeds. */
  data: DashboardEndpointsResponse | undefined;
  /** The first load failed and nothing is listed yet; reload() tries again. */
  failed: boolean;
  /**
   * Loads the list again (emitDashboardEndpointsChanged does the same from
   * anywhere). Settles once the newest load has, with whether it succeeded.
   */
  reload: () => Promise<boolean>;
}

const DashboardEndpointsContext = createContext<DashboardEndpointsValue | null>(null);

/** Claims a guest endpoint made before signing up (kept in localStorage by the landing page). */
async function claimStoredGuestEndpoint(accessToken: string): Promise<void> {
  try {
    const stored = localStorage.getItem("demo_endpoint");
    if (!stored) return;
    const parsed = JSON.parse(stored) as { slug?: string };
    if (parsed.slug) await claimGuestEndpointForUser(accessToken, parsed.slug);
    localStorage.removeItem("demo_endpoint");
  } catch {
    // Claiming is best effort; the list loads either way.
  }
}

/**
 * The dashboard's one list of endpoints, for the page and the header's
 * switcher alike (the loading rules are in lib/dashboard-endpoints-loader.ts).
 * Each used to load its own copy, so every dashboard load asked for the list
 * twice, and the switcher, empty until its copy came, pushed the page down
 * when it appeared.
 *
 * Mounted inside RequireAuth: outside it a session that still owes its
 * second factor would be refused, and the list would never load.
 */
export function DashboardEndpointsProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const accessToken = session?.access_token ?? null;
  const userId = session?.user.id ?? null;
  // Kept with the account it belongs to, so another account signed in on
  // this page never sees the last one's list, even for a frame.
  const [state, setState] = useState<DashboardEndpointsState | null>(null);
  const [loader] = useState(() =>
    createEndpointsLoader({
      claim: claimStoredGuestEndpoint,
      fetchList: fetchDashboardEndpoints,
      setState,
      onError: (error) => console.error("Failed to load dashboard endpoints:", error),
    })
  );

  const reload = useCallback(
    () => (accessToken && userId ? loader.reload(accessToken, userId) : Promise.resolve(false)),
    [loader, accessToken, userId]
  );

  useEffect(() => {
    if (!accessToken) return;
    void reload();
    return subscribeDashboardEndpointsChanged(() => {
      void reload();
    });
  }, [accessToken, reload]);

  const mine = state?.userId === userId ? state : null;
  const data = mine?.data;
  const failed = mine?.failed ?? false;
  const value = useMemo(() => ({ data, failed, reload }), [data, failed, reload]);
  return (
    <DashboardEndpointsContext.Provider value={value}>
      {children}
    </DashboardEndpointsContext.Provider>
  );
}

export function useDashboardEndpoints(): DashboardEndpointsValue {
  const value = useContext(DashboardEndpointsContext);
  if (!value) throw new Error("useDashboardEndpoints needs a DashboardEndpointsProvider");
  return value;
}
