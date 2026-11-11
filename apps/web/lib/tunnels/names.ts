import { ENTITLEMENTS } from "@/lib/entitlements";
import { createAdminClient } from "@/lib/supabase/admin";
import { inChunks } from "@/lib/supabase/in-chunks";
import { reportError } from "@/lib/observability";
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
 * own. An account's own names count against its plan's reserved names; a
 * team's names count against the team (its plan's names per seat, times its
 * seats), whoever keeps them. After a downgrade or a seat reduction the
 * oldest ones allowed stay usable and the rest wait, never deleted. When a
 * member leaves or is removed, the names they kept in that team go to the
 * team's owner (handOverTeamNames), which moves no one's own count.
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
 * The account's own names its plan covers: the oldest `limit` of the names it
 * keeps outside any team, by when they were kept. Names past the plan's count
 * (after a downgrade) are kept but not usable until others are released or
 * the plan grows. A team's names never count here (teamNameCap).
 */
export async function coveredOwnNames(userId: string, limit: number): Promise<Set<string>> {
  if (limit <= 0) return new Set();
  const { data, error } = await createAdminClient()
    .from("tunnel_names")
    .select("name")
    .eq("user_id", userId)
    .is("team_id", null)
    .order("created_at", { ascending: true })
    .order("name", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return new Set((data ?? []).map((n) => n.name));
}

/**
 * How many names a team may keep: its plan's names per seat, times its seats
 * (at least one), as tunnel_reserve_name() counts them.
 */
export function teamNameCap(seats: number | null, business: boolean): number {
  return ENTITLEMENTS[business ? "team_business" : "team"].reservedNames * Math.max(seats ?? 0, 1);
}

/** The name caps of these teams (teamNameCap), in one query. */
export async function teamNameCaps(teamIds: string[]): Promise<Map<string, number>> {
  const caps = new Map<string, number>();
  const ids = [...new Set(teamIds)];
  if (ids.length === 0) return caps;
  const admin = createAdminClient();
  const data = await inChunks(ids, (chunk) =>
    admin.from("teams").select("id, seats, business").in("id", chunk)
  );
  for (const t of data) caps.set(t.id, teamNameCap(t.seats, t.business));
  return caps;
}

/** Pure: the oldest `limit` names, by when they were kept, then by name. */
export function oldestNames(
  rows: { name: string; created_at: string }[],
  limit: number
): Set<string> {
  return new Set(
    [...rows]
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name))
      .slice(0, Math.max(0, limit))
      .map((r) => r.name)
  );
}

/** The team's names its cap covers: the oldest ones, as for own names. */
async function coveredTeamNames(teamId: string): Promise<Set<string>> {
  const cap = (await teamNameCaps([teamId])).get(teamId) ?? 0;
  if (cap <= 0) return new Set();
  const { data, error } = await createAdminClient()
    .from("tunnel_names")
    .select("name, created_at")
    .eq("team_id", teamId)
    .order("created_at", { ascending: true })
    .order("name", { ascending: true })
    .limit(cap);
  if (error) throw error;
  return new Set((data ?? []).map((n) => n.name));
}

/** What an account is told about a name it keeps past its plan's count. */
export function pastCountMessage(plan: TunnelPlan): string {
  return `${plan.label} covers ${plan.limits.reservedNames} reserved ${plan.limits.reservedNames === 1 ? "name" : "names"}, and this one is past that. Release another with whk names release <name>, or move to a bigger plan, to use it.`;
}

/** What a member is told about a team name past the team's count. */
export const PAST_TEAM_COUNT =
  "This team keeps more names than its seats cover, and this one is past that. Release another team name with whk names release <name>, or add seats, to use it.";

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
      if (plan.activeTeamIds.includes(held.team_id)) {
        if (!(await coveredTeamNames(held.team_id)).has(name))
          return { error: PAST_TEAM_COUNT, status: 403 };
        return { name, yours: true };
      }
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

/** A team at its names per seat, for a new name or one moved in. */
const TEAM_FULL = {
  error:
    "That team keeps as many names as its seats cover. Release a team name with whk names release <name>, or add seats, first.",
  status: 403,
} as const;

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
  if (standing.yours) {
    if (teamId === null) return { name, reserved: false };
    return moveIntoTeam(userId, name, teamId);
  }
  const { data, error } = await createAdminClient().rpc("tunnel_reserve_name", {
    p_user_id: userId,
    p_team_id: teamId,
    p_name: name,
    p_limit: plan.limits.reservedNames,
  });
  if (error) throw error;
  if (data === "limit")
    return {
      error: `You have ${plan.limits.reservedNames} reserved ${plan.limits.reservedNames === 1 ? "name" : "names"}, the most on ${plan.label}. Release one with whk names release <name> first.`,
      status: 403,
    };
  if (data === "team_limit") return TEAM_FULL;
  if (data === "taken") return { error: "That name is taken.", status: 409 };
  return { name, reserved: true };
}

/**
 * A reserve with a team for a name the account has already: one's own name
 * moves into the team (the team's cap allowing), a name already in that team
 * stays, and a name of another team is refused rather than left silently
 * where it was.
 */
async function moveIntoTeam(userId: string, name: string, teamId: string): Promise<ReserveResult> {
  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("tunnel_names")
    .select("user_id, team_id")
    .eq("name", name)
    .maybeSingle();
  if (error) throw error;
  if (!row) return { error: NAME_NOT_FOUND, status: 404 };
  if (row.team_id === teamId) return { name, reserved: false };
  if (row.team_id !== null)
    return {
      error:
        "That name already belongs to another of your teams. Release it there with whk names release <name> first, or pick another name.",
      status: 409,
    };
  const { data, error: moveError } = await admin.rpc("tunnel_move_name_to_team", {
    p_user_id: userId,
    p_team_id: teamId,
    p_name: name,
  });
  if (moveError) throw moveError;
  // A plan limit, as when reserving a new name: 403, never 409 (taken).
  if (data === "team_limit") return TEAM_FULL;
  if (data !== "ok") return { error: NAME_NOT_FOUND, status: 404 };
  return { name, reserved: true };
}

/**
 * The name a preview runs under. Without a request, a random one; with one,
 * the name as reserveName keeps it (`reserved` when this kept it just now,
 * which the caller audits like the reserve route).
 */
/**
 * Takes back a name `whk share --name` reserved moments ago when the share
 * itself was refused (no free slot, say), so a refused share never uses up
 * one of the plan's names. Only the account's own, team-less row goes.
 */
export async function undoShareReservation(userId: string, name: string): Promise<void> {
  const { error } = await createAdminClient()
    .from("tunnel_names")
    .delete()
    .eq("name", name)
    .eq("user_id", userId)
    .is("team_id", null);
  if (error) throw error;
}

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
   * plan's count, for a team's names past the team's count, and for names of
   * a team whose subscription ended.
   */
  usable: boolean;
  createdAt: string;
}

/** A team's names against its cap, as the names API reports them. */
export interface TeamNameCount {
  teamId: string;
  limit: number;
  used: number;
}

export interface NamesView {
  names: UsableName[];
  /** One's own names (outside teams) against one's plan. */
  own: { limit: number; used: number };
  /** Each of one's teams' names against the team's cap. */
  teams: TeamNameCount[];
}

/** The names an account sees: its own and its teams'. */
export async function namesOf(userId: string, plan: TunnelPlan): Promise<UsableName[]> {
  return (await namesView(userId, plan)).names;
}

/** The names an account sees, with its own and its teams' counts. */
export async function namesView(userId: string, plan: TunnelPlan): Promise<NamesView> {
  const { teamIds } = plan;
  const admin = createAdminClient();
  const filter =
    teamIds.length > 0
      ? `user_id.eq.${userId},team_id.in.(${teamIds.join(",")})`
      : `user_id.eq.${userId}`;
  const [{ data, error }, caps] = await Promise.all([
    admin.from("tunnel_names").select("*").or(filter).order("created_at", { ascending: true }),
    teamNameCaps(teamIds),
  ]);
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
  // One's own names count against one's plan, a team's against the team
  // (as coveredOwnNames and coveredTeamNames): each covers its oldest names.
  const own = rows.filter((r) => r.user_id === userId && r.team_id === null);
  const coveredOwn = oldestNames(own, plan.limits.reservedNames);
  const coveredTeam = new Map<string, Set<string>>();
  for (const teamId of teamIds)
    coveredTeam.set(
      teamId,
      oldestNames(
        rows.filter((r) => r.team_id === teamId),
        caps.get(teamId) ?? 0
      )
    );
  const names = rows.map((r) => ({
    name: r.name,
    teamId: r.team_id,
    reservedBy: emails.has(r.user_id) ? { id: r.user_id, email: emails.get(r.user_id)! } : null,
    mine: r.user_id === userId,
    password: r.password_version !== null,
    usable:
      r.team_id !== null
        ? plan.activeTeamIds.includes(r.team_id) &&
          (coveredTeam.get(r.team_id)?.has(r.name) ?? false)
        : coveredOwn.has(r.name),
    createdAt: r.created_at,
  }));
  return {
    names,
    own: { limit: plan.limits.reservedNames, used: own.length },
    teams: teamIds.map((teamId) => ({
      teamId,
      limit: caps.get(teamId) ?? 0,
      used: rows.filter((r) => r.team_id === teamId).length,
    })),
  };
}

/** What an account is told about a name it neither keeps nor shares a team with. */
export const NAME_NOT_FOUND =
  "No name like that is yours or your team's. List them with whk names ls.";

export type NameRefusal = { error: string; status: number };

/**
 * Who may release a name or change its password: its keeper for an own name;
 * for a team's name, its keeper or the team's owner, and only while they are
 * in the team. `activeTeamIds` set also asks for the team's subscription to be
 * live (password changes); releasing works after a lapse too, so names are
 * never stuck. Null when the account may; otherwise why not, as an answer an
 * agent can act on: 404 only when the name is not one the account can see
 * (its own or a team's it is in), 403 with who may when it can see it.
 */
export async function nameManageRefusal(
  userId: string,
  row: { user_id: string | null; team_id: string | null },
  teamIds: string[],
  activeTeamIds: string[] | null
): Promise<NameRefusal | null> {
  const visible =
    (row.team_id === null && row.user_id === userId) ||
    (row.team_id !== null && teamIds.includes(row.team_id));
  if (!visible) return { error: NAME_NOT_FOUND, status: 404 };
  if (row.team_id === null) return null;
  if (activeTeamIds !== null && !activeTeamIds.includes(row.team_id))
    return {
      error:
        "That name belongs to a team whose subscription has ended, so it can't be changed until the team subscribes again. Releasing it still works: whk names release <name>.",
      status: 403,
    };
  const { data: member, error } = await createAdminClient()
    .from("team_members")
    .select("role")
    .eq("team_id", row.team_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!member) return { error: NAME_NOT_FOUND, status: 404 };
  if (row.user_id === userId || member.role === "owner") return null;
  return {
    error:
      "Only the person who reserved this team name or the team's owner can change or release it.",
    status: 403,
  };
}

/**
 * Lets a name go (see nameManageRefusal). A preview running under it stops,
 * so the name's password never comes off a live link.
 */
export async function releaseName(
  userId: string,
  teamIds: string[],
  name: string
): Promise<{ ok: true } | NameRefusal> {
  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("tunnel_names")
    .select("user_id, team_id")
    .eq("name", name)
    .maybeSingle();
  if (error) throw error;
  if (!row) return { error: NAME_NOT_FOUND, status: 404 };
  const refusal = await nameManageRefusal(userId, row, teamIds, null);
  if (refusal) return refusal;
  const { error: deleteError } = await admin.from("tunnel_names").delete().eq("name", name);
  if (deleteError) throw deleteError;
  await stopShares({ name }, "released");
  return { ok: true };
}

/**
 * Before a team goes (deleted, or with its owner's account): its names go with
 * it, so previews running under them stop first, rather than carry on under
 * a name no one keeps any more, without its password. Never throws; the
 * caller is deleting the team either way.
 */
export async function stopSharesUnderTeamNames(teamIds: string[]): Promise<void> {
  if (teamIds.length === 0) return;
  try {
    const admin = createAdminClient();
    const { data: names, error } = await admin
      .from("tunnel_names")
      .select("name")
      .in("team_id", teamIds);
    if (error) throw error;
    if (!names || names.length === 0) return;
    const open = await inChunks(
      names.map((n) => n.name),
      (chunk) =>
        admin
          .from("tunnel_shares")
          .select("id")
          .eq("kind", "share")
          .is("ended_at", null)
          .in("name", chunk)
    );
    await stopShares({ ids: open.map((s) => s.id) }, "access");
  } catch (err) {
    reportError("Failed to stop previews under a deleted team's names", err);
  }
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
