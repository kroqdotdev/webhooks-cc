import { createAdminClient } from "@/lib/supabase/admin";
import { FINAL_ENDINGS } from "./stops";
import type { TunnelPlan } from "./plan";

/*
 * Runs as the web app records them. The edge asks to open one when the CLI
 * connects and says when it closes; the plan's number of live runs is held by
 * tunnel_open_share(), in one place.
 */

export type ShareRow = {
  id: string;
  kind: "share" | "live";
  user_id: string;
  name: string | null;
  endpoint_id: string | null;
  free: boolean;
  client: string;
  key_id: string | null;
  instance: string | null;
  client_address: string | null;
  started_at: string;
  expires_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  password_hash: string | null;
  password_version: string | null;
  bytes: number;
  requests: number;
};

/** Live sessions an account may hold at once, whatever its plan. */
export const LIVE_SLOTS = 5;

export type OpenResult =
  { shareId: string; expiresAt: Date | null } | { error: string; status: number; taken?: boolean };

/**
 * Records a new run. A preview under a name the account already runs replaces
 * that run (the newest connection wins); otherwise the plan's number of live
 * previews must not be reached.
 */
export async function openShare(input: {
  userId: string;
  plan: TunnelPlan;
  kind: "share" | "live";
  name: string | null;
  endpointId: string | null;
  client: string;
  keyId: string | null;
  instance: string | null;
  clientAddress: string | null;
  password: { hash: string; version: string } | null;
}): Promise<OpenResult> {
  const slots = input.kind === "live" ? LIVE_SLOTS : input.plan.limits.shareSlots;
  const { data, error } = await createAdminClient().rpc("tunnel_open_share", {
    p_user_id: input.userId,
    p_kind: input.kind,
    p_name: input.name,
    p_endpoint_id: input.endpointId,
    p_slots: slots,
    p_session_minutes: input.kind === "live" ? null : input.plan.limits.shareSessionMinutes,
    p_free: input.plan.key === "free",
    p_client: input.client,
    p_key_id: input.keyId,
    p_instance: input.instance,
    p_client_address: input.clientAddress,
    p_password_hash: input.password?.hash ?? null,
    p_password_version: input.password?.version ?? null,
  });
  if (error) throw error;
  const answer = data as { shareId?: string; expiresAt?: string | null; error?: string };
  if (answer.error === "taken") return { error: "That name is taken.", status: 409, taken: true };
  if (answer.error === "slots") {
    const what = input.kind === "live" ? "live tunnels" : "live shares";
    return {
      error: `${input.plan.label} allows ${slots} ${what} at a time. Stop one first.`,
      status: 429,
    };
  }
  if (answer.error || !answer.shareId) return { error: "That account is gone.", status: 401 };
  return {
    shareId: answer.shareId,
    expiresAt: answer.expiresAt ? new Date(answer.expiresAt) : null,
  };
}

export async function closeShare(id: string, reason: string): Promise<void> {
  const { error } = await createAdminClient().rpc("tunnel_end_shares", {
    p_ids: [id],
    p_reason: reason.slice(0, 40),
  });
  if (error) throw error;
}

/** When the edge starts: every run it had is gone. */
export async function closeAllOpen(reason: string): Promise<number> {
  const { data, error } = await createAdminClient().rpc("tunnel_close_all_open", {
    p_reason: reason,
  });
  if (error) throw error;
  return data ?? 0;
}

/**
 * The name a run had before it reconnected (the edge restarted, the tunnel
 * dropped), so a random name stays the link that was sent.
 */
export async function runName(userId: string, instance: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("tunnel_shares")
    .select("name")
    .eq("user_id", userId)
    .eq("instance", instance)
    .eq("kind", "share")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.name ?? null;
}

/** Why a run was ended for good, if it was. */
export async function stoppedRun(userId: string, instance: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("tunnel_shares")
    .select("end_reason")
    .eq("user_id", userId)
    .eq("instance", instance)
    .in("end_reason", FINAL_ENDINGS)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.end_reason ?? null;
}

/**
 * Who else shares under this name right now: one preview runs under a name at
 * a time, and a teammate's is theirs until stopped.
 */
export async function someoneElseSharing(name: string, userId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("tunnel_shares")
    .select("user_id")
    .eq("name", name)
    .eq("kind", "share")
    .is("ended_at", null)
    .neq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: user } = await admin
    .from("users")
    .select("email")
    .eq("id", data.user_id)
    .maybeSingle();
  return user?.email ?? "Someone in your team";
}
