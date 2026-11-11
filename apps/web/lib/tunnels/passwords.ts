import { createAdminClient } from "@/lib/supabase/admin";
import { inChunks } from "@/lib/supabase/in-chunks";
import { nameManageRefusal, NAME_NOT_FOUND, type NameRefusal } from "./names";
import { hashPassword, newPasswordVersion, verifyPassword } from "./password-hash";

/*
 * Passwords on links (Pro and Business). A preview gets one from `whk share
 * --password` for that run, or from its kept name, which then holds for every
 * preview under the name; a run's own wins. A team name's holds for everyone
 * in the team. Only a hash is kept. The edge shows visitors a password page,
 * asks /api/edge/unlock whether what they typed is right, and lets them in
 * with a cookie bound to the password's version: a new password sends
 * everyone back to the password page, a CLI reconnecting with the same one
 * does not.
 */

export interface Gate {
  hash: string;
  version: string;
}

interface ShareGateColumns {
  id: string;
  name: string | null;
  /** Null once the account is deleted: such a run has no gate of its name. */
  user_id: string | null;
  password_hash: string | null;
  password_version: string | null;
}

/** Whether a kept name serves the account that runs a preview under it. */
async function nameServes(
  row: { user_id: string; team_id: string | null },
  userId: string
): Promise<boolean> {
  if (row.user_id === userId) return true;
  if (!row.team_id) return false;
  const { data, error } = await createAdminClient()
    .from("team_members")
    .select("id")
    .eq("team_id", row.team_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/** What a preview is behind, if anything: its own password, else its name's. */
export async function gateOf(share: ShareGateColumns): Promise<Gate | null> {
  if (share.password_hash && share.password_version)
    return { hash: share.password_hash, version: share.password_version };
  if (!share.name || !share.user_id) return null;
  const { data, error } = await createAdminClient()
    .from("tunnel_names")
    .select("user_id, team_id, password_hash, password_version")
    .eq("name", share.name)
    .maybeSingle();
  if (error) throw error;
  if (!data?.password_hash || !data.password_version) return null;
  if (!(await nameServes(data, share.user_id))) return null;
  return { hash: data.password_hash, version: data.password_version };
}

/**
 * The versions the edge should hold for these live previews (sync, every 30
 * seconds): three reads whatever the number of previews (each in chunks of
 * at most 200, lib/supabase/in-chunks.ts), the same answer gateOf() gives
 * for each.
 */
export async function gateVersions(
  shareIds: string[]
): Promise<{ shareId: string; gate: string | null }[]> {
  if (shareIds.length === 0) return [];
  const admin = createAdminClient();
  const shares = await inChunks(shareIds, (chunk) =>
    admin
      .from("tunnel_shares")
      .select("id, name, user_id, password_hash, password_version")
      .in("id", chunk)
      .eq("kind", "share")
      .is("ended_at", null)
  );
  // Previews without a password of their own follow their name's.
  const followers = shares.filter((s) => !s.password_version && s.name && s.user_id);
  const names = [...new Set(followers.map((s) => s.name as string))];
  const kept = new Map<
    string,
    { user_id: string; team_id: string | null; password_version: string | null }
  >();
  if (names.length > 0) {
    const rows = await inChunks(names, (chunk) =>
      admin
        .from("tunnel_names")
        .select("name, user_id, team_id, password_version")
        .in("name", chunk)
        .not("password_version", "is", null)
    );
    for (const r of rows) kept.set(r.name, r);
  }
  // Teammates under a team's name: one membership query for all of them.
  const teamAsks = followers.filter((s) => {
    const k = kept.get(s.name as string);
    return k && k.user_id !== s.user_id && k.team_id;
  });
  const member = new Set<string>();
  if (teamAsks.length > 0) {
    // By user only (an account is in few teams), so one list is chunked.
    const teamIds = new Set(teamAsks.map((s) => kept.get(s.name as string)!.team_id!));
    const userIds = [...new Set(teamAsks.map((s) => s.user_id as string))];
    const rows = await inChunks(userIds, (chunk) =>
      admin.from("team_members").select("team_id, user_id").in("user_id", chunk)
    );
    for (const r of rows) if (teamIds.has(r.team_id)) member.add(`${r.team_id}:${r.user_id}`);
  }
  return shares.map((s) => {
    if (s.password_version && s.password_hash) return { shareId: s.id, gate: s.password_version };
    const k = s.name && s.user_id ? kept.get(s.name) : undefined;
    const serves =
      !!k && (k.user_id === s.user_id || (!!k.team_id && member.has(`${k.team_id}:${s.user_id}`)));
    return { shareId: s.id, gate: serves ? k!.password_version : null };
  });
}

export async function passwordMatches(gate: Gate, password: string): Promise<boolean> {
  return verifyPassword(gate.hash, password);
}

/**
 * Sets (or with null, removes) the password on a kept name. Who may: as for
 * releasing it (nameManageRefusal: its keeper, or a team's owner, while in
 * the team), and for a team's name only while the team's subscription is
 * live. Returns the live preview under the name whose gate changed, for the
 * edge (null when none follows the name), or why the account may not.
 */
export async function setNamePassword(
  userId: string,
  teamIds: string[],
  activeTeamIds: string[],
  name: string,
  password: string | null
): Promise<{ refused: NameRefusal } | { shareId: string; gate: string | null } | null> {
  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("tunnel_names")
    .select("user_id, team_id")
    .eq("name", name)
    .maybeSingle();
  if (error) throw error;
  if (!row) return { refused: { error: NAME_NOT_FOUND, status: 404 } };
  const refusal = await nameManageRefusal(userId, row, teamIds, activeTeamIds);
  if (refusal) return { refused: refusal };
  const version = password ? newPasswordVersion() : null;
  const { error: updateError } = await admin
    .from("tunnel_names")
    .update({
      password_hash: password ? await hashPassword(password) : null,
      password_version: version,
    })
    .eq("name", name);
  if (updateError) throw updateError;
  // A live preview with a password of its own keeps it.
  const { data: live, error: liveError } = await admin
    .from("tunnel_shares")
    .select("id")
    .eq("name", name)
    .eq("kind", "share")
    .is("ended_at", null)
    .is("password_hash", null)
    .maybeSingle();
  if (liveError) throw liveError;
  return live ? { shareId: live.id, gate: version } : null;
}
