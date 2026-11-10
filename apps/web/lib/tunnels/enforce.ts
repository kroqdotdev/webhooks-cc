import { createAdminClient } from "@/lib/supabase/admin";
import { tunnelPlansOf, type TunnelPlan } from "./plan";
import { STOPS } from "./stops";

/*
 * A plan is checked when a run opens; this keeps open previews within the
 * account's plan as it is now (a downgrade, a refund, a team's subscription
 * ending). The edge's sync runs it every 30 seconds, in a fixed few queries:
 *
 * - a plan with a time limit gives runs opened without one the limit, counted
 *   from when they started (the sync then ends those past it as "time limit");
 * - previews with a password of their own end when the plan has no passwords;
 * - previews under one's own reserved name end when the plan no longer covers
 *   the name (names past the plan's count, the newest first, wait; never
 *   deleted);
 * - previews beyond the plan's number at once end, the newest first.
 *
 * Those end as "plan changed", a stop: the CLI says why and does not
 * reconnect. Live tunnels are not previews and keep their own cap.
 */

interface OpenRun {
  id: string;
  user_id: string;
  name: string | null;
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
  /** Runs to give an expiry: id and when. */
  expire: { id: string; at: string }[];
}

/** Pure: what the plans ask of these open runs. */
export function enforcement(
  runs: OpenRun[],
  plans: Map<string, TunnelPlan>,
  names: KeptName[]
): Enforcement {
  const end = new Set<string>();
  const expire: { id: string; at: string }[] = [];

  const keptBy = new Map<string, KeptName>();
  for (const n of names) keptBy.set(n.name, n);
  // Each account's own names, oldest first: the plan covers the first N.
  const ownNames = new Map<string, KeptName[]>();
  for (const n of names) ownNames.set(n.user_id, [...(ownNames.get(n.user_id) ?? []), n]);
  const covered = new Map<string, Set<string>>();
  for (const [userId, list] of ownNames) {
    const limit = plans.get(userId)?.limits.reservedNames ?? 0;
    const sorted = [...list].sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name)
    );
    covered.set(userId, new Set(sorted.slice(0, Math.max(0, limit)).map((n) => n.name)));
  }

  const byUser = new Map<string, OpenRun[]>();
  for (const r of runs) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);

  for (const [userId, list] of byUser) {
    const plan = plans.get(userId);
    if (!plan) continue; // a gone account is tunnel_runs_without_access()'s
    const limits = plan.limits;
    const kept: OpenRun[] = [];
    for (const r of list) {
      if (r.password_version && !limits.sharePasswords) {
        end.add(r.id);
        continue;
      }
      const name = r.name ? keptBy.get(r.name) : undefined;
      // One's own name (team names follow the team's rules elsewhere).
      if (name && name.team_id === null && name.user_id === userId) {
        if (!covered.get(userId)?.has(name.name)) {
          end.add(r.id);
          continue;
        }
      }
      kept.push(r);
    }
    // Beyond the number at once: the newest go.
    const oldestFirst = kept.sort((a, b) => a.started_at.localeCompare(b.started_at));
    for (const r of oldestFirst.slice(Math.max(0, limits.shareSlots))) end.add(r.id);
    // A time limit the run did not open with.
    const minutes = limits.shareSessionMinutes;
    if (minutes !== null)
      for (const r of oldestFirst.slice(0, Math.max(0, limits.shareSlots)))
        if (r.expires_at === null)
          expire.push({
            id: r.id,
            at: new Date(Date.parse(r.started_at) + minutes * 60_000).toISOString(),
          });
  }
  return { end: [...end], expire };
}

/** Holds every open preview to its account's current plan (see above). */
export async function enforcePlans(now = Date.now()): Promise<Enforcement> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("tunnel_shares")
    .select("id, user_id, name, password_version, started_at, expires_at")
    .eq("kind", "share")
    .is("ended_at", null)
    .not("user_id", "is", null)
    .limit(5_000);
  if (error) throw error;
  const runs = (data ?? []) as OpenRun[];
  if (runs.length === 0) return { end: [], expire: [] };
  const userIds = [...new Set(runs.map((r) => r.user_id))];
  const [plans, kept] = await Promise.all([
    tunnelPlansOf(userIds, now),
    admin.from("tunnel_names").select("name, user_id, team_id, created_at").in("user_id", userIds),
  ]);
  if (kept.error) throw kept.error;
  const result = enforcement(runs, plans, (kept.data ?? []) as KeptName[]);
  if (result.end.length > 0) {
    const { error: endError } = await admin.rpc("tunnel_end_shares", {
      p_ids: result.end,
      p_reason: STOPS.plan.record,
    });
    if (endError) throw endError;
  }
  // Rare (a plan that gained a time limit), and each run only once.
  await Promise.all(
    result.expire.map(async ({ id, at }) => {
      const { error: expireError } = await admin
        .from("tunnel_shares")
        .update({ expires_at: at })
        .eq("id", id)
        .is("expires_at", null);
      if (expireError) throw expireError;
    })
  );
  return result;
}
