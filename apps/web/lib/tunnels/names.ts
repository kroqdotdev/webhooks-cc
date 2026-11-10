import { createAdminClient } from "@/lib/supabase/admin";
import {
  drawName,
  hasWord,
  isDrawnName,
  nameProblem,
  nameShapeProblem,
  UNAVAILABLE,
} from "./name-rules";
import { namesUpsell, type TunnelPlan } from "./plan";
import { stopShares } from "./stops";

/*
 * Kept preview names (tunnel_names). A name kept inside a team (team_id) may
 * be shared under, and its password changed, by the team's current members
 * while the team's subscription is live; names kept alone stay the account's
 * own. An account's own names count against its plan's reserved names: after
 * a downgrade the oldest ones it is allowed stay usable and the rest wait,
 * never deleted. When a member leaves or is removed, the names they kept in
 * that team go to the team's owner (handOverTeamNames), so the team keeps them.
 */

interface NameRow {
  name: string;
  user_id: string;
  team_id: string | null;
  password_hash: string | null;
  password_version: string | null;
  created_at: string;
}

/**
 * The account's own names its plan covers: the oldest `limit`, by when they
 * were kept. Names past the plan's count (after a downgrade) are kept but not
 * usable until others are released or the plan grows.
 */
export async function coveredOwnNames(userId: string, limit: number): Promise<Set<string>> {
  if (limit <= 0) return new Set();
  const { data, error } = await createAdminClient()
    .from("tunnel_names")
    .select("name")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .order("name", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return new Set((data ?? []).map((n) => n.name));
}

/** What an account is told about a name it keeps past its plan's count. */
export function pastCountMessage(plan: TunnelPlan): string {
  return `${plan.label} covers ${plan.limits.reservedNames} reserved ${plan.limits.reservedNames === 1 ? "name" : "names"}, and this one is past that. Release another name or move to a bigger plan to use it.`;
}

/** What an account is told about a name of a team whose subscription ended. */
export const LAPSED_TEAM_NAME =
  "That name belongs to a team whose subscription has ended. It can be used again once the team subscribes.";

/** Why a name shaped like a random one cannot be kept. */
export const DRAWN_NAME =
  "Names like that are drawn at random for previews, so they can't be kept. Pick another.";

export async function isBlocked(name: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("tunnel_blocked_names")
    .select("name")
    .eq("name", name)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

async function hasBlockedWord(name: string): Promise<boolean> {
  const { data, error } = await createAdminClient().from("tunnel_blocked_words").select("word");
  if (error) throw error;
  return (data ?? []).some((w) => hasWord(name, w.word));
}

/**
 * Why a name may not be newly kept or drawn: its shape, the built-in lists,
 * or staff's (a blocked name, a blocked word in it).
 */
export async function nameRefusal(name: string): Promise<string | null> {
  return (
    nameProblem(name) ??
    ((await isBlocked(name)) || (await hasBlockedWord(name)) ? UNAVAILABLE : null)
  );
}

/** Whether a preview runs under the name right now, and whose. */
async function openUnder(name: string): Promise<{ user_id: string | null } | null> {
  const { data, error } = await createAdminClient()
    .from("tunnel_shares")
    .select("user_id")
    .eq("name", name)
    .eq("kind", "share")
    .is("ended_at", null)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function isKept(name: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("tunnel_names")
    .select("name")
    .eq("name", name)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/** A random name no list refuses and nothing uses. */
export async function randomName(free: boolean): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const name = drawName(free);
    // The suffix is ours; the rest must pass the lists like any name.
    const bare = free ? name.slice(0, -"-free".length) : name;
    if (await isKept(name)) continue;
    // Staff block the whole name, -free included; the lists judge the rest.
    if (await isBlocked(name)) continue;
    if (await nameRefusal(bare)) continue;
    if (await openUnder(name)) continue;
    return name;
  }
  throw new Error("Could not find a free random name");
}

/**
 * Whether a run reconnecting may have its random name back: one we draw for
 * this kind of preview, not kept since, not refused, and not run by someone
 * else, so no kept or blocked name comes back this way.
 */
export async function randomNameFree(
  userId: string,
  name: string,
  free: boolean
): Promise<boolean> {
  if (!isDrawnName(name, free)) return false;
  const bare = free ? name.slice(0, -"-free".length) : name;
  if ((await isKept(name)) || (await isBlocked(name)) || (await nameRefusal(bare))) return false;
  const open = await openUnder(name);
  return !open || open.user_id === userId;
}

export type NameStanding = { name: string; yours: boolean } | { error: string; status: number };

/**
 * Whether the account may keep a name, without keeping it: `yours` when it
 * (or one of its teams) has it already. A name kept before a word was blocked
 * stays usable until staff block the name itself.
 */
export async function nameStanding(
  userId: string,
  plan: TunnelPlan,
  requested: string
): Promise<NameStanding> {
  const name = requested.trim().toLowerCase();
  const shape = nameShapeProblem(name);
  if (shape) return { error: shape, status: 400 };
  if (await isBlocked(name)) return { error: UNAVAILABLE, status: 403 };
  if (plan.limits.reservedNames === 0) return { error: namesUpsell(plan), status: 403 };
  const { data: held, error } = await createAdminClient()
    .from("tunnel_names")
    .select("user_id, team_id")
    .eq("name", name)
    .maybeSingle();
  if (error) throw error;
  if (held) {
    // A team's name: its current members, while the team's subscription is live.
    if (held.team_id !== null) {
      if (plan.activeTeamIds.includes(held.team_id)) return { name, yours: true };
      if (plan.teamIds.includes(held.team_id)) return { error: LAPSED_TEAM_NAME, status: 403 };
      return { error: "That name is taken.", status: 409 };
    }
    if (held.user_id !== userId) return { error: "That name is taken.", status: 409 };
    // One's own name, while the plan covers it.
    if (!(await coveredOwnNames(userId, plan.limits.reservedNames)).has(name))
      return { error: pastCountMessage(plan), status: 403 };
    return { name, yours: true };
  }
  // Random names are drawn for previews and handed back on reconnects; one
  // kept by someone else would take over a link its preview had sent out.
  if (isDrawnName(name, false) || isDrawnName(name, true))
    return { error: DRAWN_NAME, status: 403 };
  if (await nameRefusal(name)) return { error: UNAVAILABLE, status: 403 };
  // A random name in use right now cannot be kept from under its preview.
  const open = await openUnder(name);
  if (open && open.user_id !== userId) return { error: "That name is taken.", status: 409 };
  return { name, yours: false };
}

export type ReserveResult = { name: string; reserved: boolean } | { error: string; status: number };

/**
 * Keeps a name for the account the first time it asks, when nameStanding
 * allows: inside `teamId` when given (a team the account belongs to), so
 * everyone in it may use it. `reserved` is false when it was the account's
 * (or its team's) already.
 */
export async function reserveName(
  userId: string,
  plan: TunnelPlan,
  requested: string,
  teamId: string | null = null
): Promise<ReserveResult> {
  if (teamId !== null && !plan.teamIds.includes(teamId))
    return { error: "You are not in that team.", status: 403 };
  if (teamId !== null && !plan.activeTeamIds.includes(teamId))
    return {
      error: "That team's subscription has ended, so it can't keep names right now.",
      status: 403,
    };
  const standing = await nameStanding(userId, plan, requested);
  if ("error" in standing) return standing;
  const { name } = standing;
  if (standing.yours) return { name, reserved: false };
  const { data, error } = await createAdminClient().rpc("tunnel_reserve_name", {
    p_user_id: userId,
    p_team_id: teamId,
    p_name: name,
    p_limit: plan.limits.reservedNames,
  });
  if (error) throw error;
  if (data === "limit")
    return {
      error: `You have ${plan.limits.reservedNames} reserved ${plan.limits.reservedNames === 1 ? "name" : "names"}, the most on ${plan.label}. Release one first.`,
      status: 403,
    };
  if (data === "taken") return { error: "That name is taken.", status: 409 };
  return { name, reserved: true };
}

/**
 * The name a preview runs under. Without a request, a random one; with one,
 * the name as reserveName keeps it (`reserved` when this kept it just now,
 * which the caller audits like the reserve route).
 */
export async function nameForShare(
  userId: string,
  plan: TunnelPlan,
  requested: string | null
): Promise<{ name: string; reserved: boolean } | { error: string; status: number }> {
  if (!requested) return { name: await randomName(plan.key === "free"), reserved: false };
  return reserveName(userId, plan, requested);
}

export interface UsableName {
  name: string;
  teamId: string | null;
  reservedBy: { id: string; email: string } | null;
  mine: boolean;
  password: boolean;
  /**
   * Whether it can be shared under now: false for one's own names past the
   * plan's count, and for names of a team whose subscription ended.
   */
  usable: boolean;
  createdAt: string;
}

/** The names an account sees: its own and its teams'. */
export async function namesOf(userId: string, plan: TunnelPlan): Promise<UsableName[]> {
  const { teamIds } = plan;
  const admin = createAdminClient();
  const filter =
    teamIds.length > 0
      ? `user_id.eq.${userId},team_id.in.(${teamIds.join(",")})`
      : `user_id.eq.${userId}`;
  const { data, error } = await admin
    .from("tunnel_names")
    .select("*")
    .or(filter)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as NameRow[];
  const holders = [...new Set(rows.map((r) => r.user_id))];
  const emails = new Map<string, string>();
  if (holders.length > 0) {
    const { data: users, error: usersError } = await admin
      .from("users")
      .select("id, email")
      .in("id", holders);
    if (usersError) throw usersError;
    for (const u of users ?? []) emails.set(u.id, u.email);
  }
  // Names one keeps count against one's plan by when they were kept (as in
  // coveredOwnNames): the plan covers the oldest ones.
  const covered = new Set(
    rows
      .filter((r) => r.user_id === userId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name))
      .slice(0, Math.max(0, plan.limits.reservedNames))
      .map((r) => r.name)
  );
  return rows.map((r) => ({
    name: r.name,
    teamId: r.team_id,
    reservedBy: emails.has(r.user_id) ? { id: r.user_id, email: emails.get(r.user_id)! } : null,
    mine: r.user_id === userId,
    password: r.password_version !== null,
    usable: r.team_id !== null ? plan.activeTeamIds.includes(r.team_id) : covered.has(r.name),
    createdAt: r.created_at,
  }));
}

/**
 * Who may release a name or change its password: its keeper for an own name;
 * for a team's name, its keeper or the team's owner, and only while they are
 * in the team. `activeTeamIds` set also asks for the team's subscription to be
 * live (password changes); releasing works after a lapse too, so names are
 * never stuck.
 */
export async function mayManageName(
  userId: string,
  row: { user_id: string; team_id: string | null },
  activeTeamIds: string[] | null
): Promise<boolean> {
  if (row.team_id === null) return row.user_id === userId;
  if (activeTeamIds !== null && !activeTeamIds.includes(row.team_id)) return false;
  const { data: member, error } = await createAdminClient()
    .from("team_members")
    .select("role")
    .eq("team_id", row.team_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!member) return false;
  return row.user_id === userId || member.role === "owner";
}

/**
 * Lets a name go (see mayManageName). A preview running under it stops, so
 * the name's password never comes off a live link. False when the account
 * may not.
 */
export async function releaseName(userId: string, name: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("tunnel_names")
    .select("user_id, team_id")
    .eq("name", name)
    .maybeSingle();
  if (error) throw error;
  if (!row) return false;
  if (!(await mayManageName(userId, row, null))) return false;
  const { error: deleteError } = await admin.from("tunnel_names").delete().eq("name", name);
  if (deleteError) throw deleteError;
  await stopShares({ name }, "released");
  return true;
}

/**
 * When a member leaves a team or is removed: the names they kept in it go to
 * the team's owner, so the team keeps them and the former member cannot use,
 * release or re-password them. Run before the membership row goes.
 */
export async function handOverTeamNames(teamId: string, leavingUserId: string): Promise<void> {
  const admin = createAdminClient();
  const { data: owner, error } = await admin
    .from("team_members")
    .select("user_id")
    .eq("team_id", teamId)
    .eq("role", "owner")
    .maybeSingle();
  if (error) throw error;
  if (!owner || owner.user_id === leavingUserId) return;
  const { error: moveError } = await admin
    .from("tunnel_names")
    .update({ user_id: owner.user_id })
    .eq("team_id", teamId)
    .eq("user_id", leavingUserId);
  if (moveError) throw moveError;
}
