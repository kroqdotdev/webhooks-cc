"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import type { Team, TeamInvite } from "@/lib/supabase/teams-types";

interface SettingsData {
  teams: Team[];
  /** Invites addressed to the signed-in user, waiting for an answer. */
  invites: TeamInvite[];
  /** True until the first load settles. */
  loading: boolean;
  loadError: boolean;
  /**
   * Re-reads teams and invites without dropping what is on screen. With
   * `reuse`, a read already in flight is shared instead of starting another;
   * leave it off after a change, so the read starts after the change.
   */
  refresh: (options?: { reuse?: boolean }) => Promise<void>;
  /** Replaces one team in place after a page fetched it fresh. */
  updateTeam: (team: Team) => void;
}

const SettingsDataContext = createContext<SettingsData | null>(null);

/**
 * Teams and invites, loaded once for the whole settings area: the side nav
 * lists the teams, and the teams pages read the same list instead of fetching
 * it again on every navigation.
 */
export function SettingsDataProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const accessToken = session?.access_token ?? null;
  const [teams, setTeams] = useState<Team[]>([]);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // Pages refresh on open so seats, members and usage are current; that read
  // and the provider's own first load share one request.
  const inFlight = useRef<Promise<void> | null>(null);
  // Only the newest read may write, so a slow older one cannot undo a newer one.
  const latest = useRef(0);

  const refresh = useCallback(
    async ({ reuse = false }: { reuse?: boolean } = {}) => {
      if (!accessToken) return;
      if (reuse && inFlight.current) return inFlight.current;
      const headers = { Authorization: `Bearer ${accessToken}` };
      const id = ++latest.current;
      const run = (async () => {
        try {
          const [teamsRes, invitesRes] = await Promise.all([
            fetch("/api/teams", { headers }),
            fetch("/api/invites", { headers }),
          ]);
          if (id !== latest.current) return;
          if (!teamsRes.ok || !invitesRes.ok) {
            setLoadError(true);
            return;
          }
          const [nextTeams, nextInvites] = await Promise.all([
            teamsRes.json() as Promise<Team[]>,
            invitesRes.json() as Promise<TeamInvite[]>,
          ]);
          if (id !== latest.current) return;
          setTeams(nextTeams);
          setInvites(nextInvites);
          setLoadError(false);
        } catch {
          if (id === latest.current) setLoadError(true);
        } finally {
          // A superseded read must not end loading before the newer one has data.
          if (id === latest.current) {
            setLoading(false);
            inFlight.current = null;
          }
        }
      })();
      inFlight.current = run;
      return run;
    },
    [accessToken]
  );

  useEffect(() => {
    void refresh({ reuse: true });
  }, [refresh]);

  const updateTeam = useCallback((team: Team) => {
    setTeams((previous) => previous.map((t) => (t.id === team.id ? team : t)));
  }, []);

  const value = useMemo(
    () => ({ teams, invites, loading, loadError, refresh, updateTeam }),
    [teams, invites, loading, loadError, refresh, updateTeam]
  );

  return <SettingsDataContext.Provider value={value}>{children}</SettingsDataContext.Provider>;
}

export function useSettingsData(): SettingsData {
  const value = useContext(SettingsDataContext);
  if (!value) throw new Error("useSettingsData must be used inside SettingsDataProvider");
  return value;
}
