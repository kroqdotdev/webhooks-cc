import { createAdminClient } from "@/lib/supabase/admin";
import { inChunks } from "@/lib/supabase/in-chunks";
import { oldestNames, teamNameCaps } from "./names";
import { tunnelPlansOf, type TunnelPlan } from "./plan";
import { STOPS } from "./stops";

/*
 * A plan is checked when a run opens; this keeps open previews within the
 * account's plan as it is now (a downgrade, a refund, a team's subscription
 * ending, a seat reduction). The edge's sync runs it every 30 seconds, in a
 * fixed few queries. A preview ends when:
 *
 * - it opened as a paid preview and the plan is now Free (its name is no
 *   -free name), or it opened without the visitor notice and the plan now
 *   asks for it: started again, it gets the name and notice the plan gives;
 * - the plan now has a time limit and the run opened without one: the edge
 *   cannot tell a running CLI about a new limit, so the run ends and starts
 *   again with its limit known, rather than being cut off without warning;
 * - it has a password of its own and the plan has no passwords;
 * - it runs under one's own reserved name past the plan's count, or under a
 *   team's name past the team's count (the newest names wait; never deleted);
 * - it is beyond the plan's number at once (the newest go).
 *
 * Those end as "plan changed", a stop: the CLI says why and does not
 * reconnect. Live tunnels are not previews and keep their own cap.
 */

interface OpenRun {
  id: string;
  user_id: string;
  name: string | null;
  free: boolean;
  notice: boolean;
  password_version: string | null;
  started_at: string;
  expires_at: string | null;
}

interface KeptName {
  name: string;
  user_id: string;
  team_id: string | null;
  created_at: string;
}

export interface Enforcement {
  /** Runs to end as "plan changed". */
  end: string[];
}

/**
 * Pure: what the plans ask of these open runs. `names` holds the runs'
 * accounts' own names and every name of the teams the runs' names belong to;
 * `teamCaps` each of those teams' name cap.
 */
export function enforcement(
  runs: OpenRun[],
  plans: Map<string, TunnelPlan>,
  names: KeptName[],
  teamCaps: Map<string, number> = new Map()
): Enforcement {
  const end = new Set<string>();

  const keptBy = new Map<string, KeptName>();
  for (const n of names) keptBy.set(n.name, n);
  // Each account's own names, and each team's, oldest first: the plan (or the
  // team's cap) covers the first N.
  const ownNames = new Map<string, KeptName[]>();
  const teamNames = new Map<string, KeptName[]>();
  for (const n of names) {
    if (n.team_id === null) ownNames.set(n.user_id, [...(ownNames.get(n.user_id) ?? []), n]);
    else teamNames.set(n.team_id, [...(teamNames.get(n.team_id) ?? []), n]);
  }
  const coveredOwn = new Map<string, Set<string>>();
  for (const [userId, list] of ownNames)
    coveredOwn.set(userId, oldestNames(list, plans.get(userId)?.limits.reservedNames ?? 0));
  const coveredTeam = new Map<string, Set<string>>();
  for (const [teamId, list] of teamNames)
    coveredTeam.set(teamId, oldestNames(list, teamCaps.get(teamId) ?? 0));

  const byUser = new Map<string, OpenRun[]>();
  for (const r of runs) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);

  for (const [userId, list] of byUser) {
    const plan = plans.get(userId);
    if (!plan) continue; // a gone account is tunnel_runs_without_access()'s
    const limits = plan.limits;
    const kept: OpenRun[] = [];
    for (const r of list) {
      const paidOnFree = plan.key === "free" && !r.free;
      const noticeNow = plan.notice && !r.notice;
      const newLimit = limits.shareSessionMinutes !== null && r.expires_at === null;
      const noPasswords = r.password_version !== null && !limits.sharePasswords;
      const name = r.name ? keptBy.get(r.name) : undefined;
      const pastOwn =
        name !== undefined &&
        name.team_id === null &&
        name.user_id === userId &&
        !coveredOwn.get(userId)?.has(name.name);
      // A team's name: past the team's cap (a lapsed team or a former member
      // is tunnel_runs_without_access()'s).
      const pastTeam =
        name !== undefined &&
        name.team_id !== null &&
        !(coveredTeam.get(name.team_id)?.has(name.name) ?? true);
      if (paidOnFree || noticeNow || newLimit || noPasswords || pastOwn || pastTeam) {
        end.add(r.id);
        continue;
      }
      kept.push(r);
    }
    // Beyond the number at once: the newest go.
    const oldestFirst = kept.sort((a, b) => a.started_at.localeCompare(b.started_at));
    for (const r of oldestFirst.slice(Math.max(0, limits.shareSlots))) end.add(r.id);
  }
  return { end: [...end] };
}

/** Holds every open preview to its account's current plan (see above). */
export async function enforcePlans(now = Date.now()): Promise<Enforcement> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("tunnel_shares")
    .select("id, user_id, name, free, notice, password_version, started_at, expires_at")
    .eq("kind", "share")
    .is("ended_at", null)
    .not("user_id", "is", null)
    .limit(5_000);
  if (error) throw error;
  const runs = (data ?? []) as OpenRun[];
  if (runs.length === 0) return { end: [] };
  const userIds = [...new Set(runs.map((r) => r.user_id))];
  const runNames = [...new Set(runs.flatMap((r) => (r.name ? [r.name] : [])))];
  // Every list here grows with the runs, so each is read in chunks.
  const [plans, own, underRuns] = await Promise.all([
    tunnelPlansOf(userIds, now),
    inChunks(userIds, (chunk) =>
      admin
        .from("tunnel_names")
        .select("name, user_id, team_id, created_at")
        .in("user_id", chunk)
        .is("team_id", null)
    ),
    inChunks(runNames, (chunk) =>
      admin.from("tunnel_names").select("team_id").in("name", chunk).not("team_id", "is", null)
    ),
  ]);
  // The teams whose names previews run under: all their names, for the cap.
  const teamIds = [...new Set(underRuns.flatMap((n) => (n.team_id ? [n.team_id] : [])))];
  const [teamRows, caps] = await Promise.all([
    inChunks(teamIds, (chunk) =>
      admin.from("tunnel_names").select("name, user_id, team_id, created_at").in("team_id", chunk)
    ),
    teamNameCaps(teamIds),
  ]);
  const names = [...(own as KeptName[]), ...(teamRows as KeptName[])];
  const result = enforcement(runs, plans, names, caps);
  if (result.end.length > 0) {
    const { error: endError } = await admin.rpc("tunnel_end_shares", {
      p_ids: result.end,
      p_reason: STOPS.plan.record,
    });
    if (endError) throw endError;
  }
  return result;
}
