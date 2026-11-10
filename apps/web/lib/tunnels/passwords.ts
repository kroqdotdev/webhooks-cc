import { createAdminClient } from "@/lib/supabase/admin";
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
  user_id: string;
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
  if (!share.name) return null;
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

/** The versions the edge should hold for these live previews (sync). */
export async function gateVersions(
  shareIds: string[]
): Promise<{ shareId: string; gate: string | null }[]> {
  if (shareIds.length === 0) return [];
  const { data, error } = await createAdminClient()
    .from("tunnel_shares")
    .select("id, name, user_id, password_hash, password_version")
    .in("id", shareIds)
    .eq("kind", "share")
    .is("ended_at", null);
  if (error) throw error;
  const out: { shareId: string; gate: string | null }[] = [];
  for (const s of data ?? []) out.push({ shareId: s.id, gate: (await gateOf(s))?.version ?? null });
  return out;
}

export async function passwordMatches(gate: Gate, password: string): Promise<boolean> {
  return verifyPassword(gate.hash, password);
}

/**
 * Sets (or with null, removes) the password on a kept name the account may
 * use. Returns the live preview under the name whose gate changed, for the
 * edge (null when none follows the name), or false when the name is not the
 * account's.
 */
export async function setNamePassword(
  userId: string,
  teamIds: string[],
  name: string,
  password: string | null
): Promise<false | { shareId: string; gate: string | null } | null> {
  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("tunnel_names")
    .select("user_id, team_id")
    .eq("name", name)
    .maybeSingle();
  if (error) throw error;
  if (!row) return false;
  if (row.user_id !== userId && !(row.team_id && teamIds.includes(row.team_id))) return false;
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
