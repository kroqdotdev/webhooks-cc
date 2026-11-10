import { getWebhookUrl } from "@/lib/constants";
import { createAdminClient } from "@/lib/supabase/admin";
import { previewUrl } from "./config";
import type { TunnelPlan } from "./plan";
import type { ShareRow } from "./shares";
import { describeEnding } from "./stops";
import type { MonthUsage } from "./usage";

/*
 * Runs and limits as the API shows them (GET /api/shares): the account's own
 * runs, and the live previews teammates run under the names of a team the
 * account is in, which any member may stop.
 */

export interface ApiShare {
  id: string;
  kind: "share" | "live";
  name: string | null;
  url: string | null;
  endpointSlug: string | null;
  client: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  expiresAt: string | null;
  bytes: number;
  requests: number;
  password: boolean;
  mine: boolean;
  startedBy: { id: string; email: string } | null;
}

export interface ApiTunnelUsage {
  month: string;
  bytes: number;
  limitBytes: number;
  over: boolean;
  resetsAt: string;
}

export interface ApiTunnelLimits {
  plan: string;
  shares: number;
  reservedNames: number;
  sessionMinutes: number | null;
  dataGb: number;
  passwords: boolean;
  notice: boolean;
}

export function apiUsage(u: MonthUsage): ApiTunnelUsage {
  return {
    month: u.month,
    bytes: u.bytes,
    limitBytes: u.allowanceBytes,
    over: u.over,
    resetsAt: u.resetsAt.toISOString(),
  };
}

export function apiLimits(plan: TunnelPlan): ApiTunnelLimits {
  return {
    plan: plan.key,
    shares: plan.limits.shareSlots,
    reservedNames: plan.limits.reservedNames,
    sessionMinutes: plan.limits.shareSessionMinutes,
    dataGb: plan.limits.shareDataGb,
    passwords: plan.limits.sharePasswords,
    notice: plan.notice,
  };
}

const COLUMNS =
  "id, kind, user_id, name, endpoint_id, free, client, key_id, instance, client_address, started_at, expires_at, ended_at, end_reason, password_hash, password_version, bytes, requests";

/** Live runs of teammates under the names of the account's teams. */
async function teamLiveShares(userId: string, teamIds: string[]): Promise<ShareRow[]> {
  if (teamIds.length === 0) return [];
  const admin = createAdminClient();
  const { data: names, error } = await admin
    .from("tunnel_names")
    .select("name")
    .in("team_id", teamIds);
  if (error) throw error;
  const list = (names ?? []).map((n) => n.name);
  if (list.length === 0) return [];
  const { data, error: sharesError } = await admin
    .from("tunnel_shares")
    .select(COLUMNS)
    .in("name", list)
    .eq("kind", "share")
    .is("ended_at", null)
    .neq("user_id", userId);
  if (sharesError) throw sharesError;
  return (data ?? []) as ShareRow[];
}

/**
 * The runs an account sees: its live ones, its latest `limit` ended ones, and
 * its teams' live previews. `state` narrows to live or ended.
 */
export async function sharesFor(
  userId: string,
  plan: TunnelPlan,
  state: "live" | "ended" | null,
  limit = 30
): Promise<ApiShare[]> {
  const admin = createAdminClient();
  const [live, ended, team] = await Promise.all([
    state === "ended"
      ? Promise.resolve({ data: [] as ShareRow[], error: null })
      : admin
          .from("tunnel_shares")
          .select(COLUMNS)
          .eq("user_id", userId)
          .is("ended_at", null)
          .order("started_at", { ascending: false }),
    state === "live"
      ? Promise.resolve({ data: [] as ShareRow[], error: null })
      : admin
          .from("tunnel_shares")
          .select(COLUMNS)
          .eq("user_id", userId)
          .not("ended_at", "is", null)
          .order("started_at", { ascending: false })
          .limit(limit),
    state === "ended" ? Promise.resolve([] as ShareRow[]) : teamLiveShares(userId, plan.teamIds),
  ]);
  if (live.error) throw live.error;
  if (ended.error) throw ended.error;
  const rows = [
    ...((live.data ?? []) as ShareRow[]),
    ...team,
    ...((ended.data ?? []) as ShareRow[]),
  ];
  return describe(rows, userId);
}

/** The API's shape for rows, with who started each and the endpoints' slugs. */
export async function describe(rows: ShareRow[], userId: string): Promise<ApiShare[]> {
  if (rows.length === 0) return [];
  const admin = createAdminClient();
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const endpointIds = [...new Set(rows.map((r) => r.endpoint_id).filter((x): x is string => !!x))];
  const names = [...new Set(rows.map((r) => r.name).filter((x): x is string => !!x))];
  const [users, endpoints, kept] = await Promise.all([
    admin.from("users").select("id, email").in("id", userIds),
    endpointIds.length > 0
      ? admin.from("endpoints").select("id, slug").in("id", endpointIds)
      : Promise.resolve({ data: [] as { id: string; slug: string }[], error: null }),
    names.length > 0
      ? admin.from("tunnel_names").select("name, password_version").in("name", names)
      : Promise.resolve({
          data: [] as { name: string; password_version: string | null }[],
          error: null,
        }),
  ]);
  if (users.error) throw users.error;
  if (endpoints.error) throw endpoints.error;
  if (kept.error) throw kept.error;
  const emailOf = new Map((users.data ?? []).map((u) => [u.id, u.email]));
  const slugOf = new Map((endpoints.data ?? []).map((e) => [e.id, e.slug]));
  const namePassword = new Set(
    (kept.data ?? []).filter((n) => n.password_version !== null).map((n) => n.name)
  );
  return rows.map((r) => {
    const slug = r.endpoint_id ? (slugOf.get(r.endpoint_id) ?? null) : null;
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      url: r.kind === "share" && r.name ? previewUrl(r.name) : slug ? getWebhookUrl(slug) : null,
      endpointSlug: slug,
      client: r.client,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      endReason: describeEnding(r.end_reason),
      expiresAt: r.expires_at,
      bytes: Number(r.bytes),
      requests: Number(r.requests),
      password: r.password_version !== null || (r.name !== null && namePassword.has(r.name)),
      mine: r.user_id === userId,
      startedBy: emailOf.has(r.user_id) ? { id: r.user_id, email: emailOf.get(r.user_id)! } : null,
    };
  });
}

/**
 * A run the account may act on: its own, or a teammate's live preview under
 * a name of one of the account's teams. Null otherwise.
 */
export async function shareFor(
  id: string,
  userId: string,
  teamIds: string[]
): Promise<{ row: ShareRow; mine: boolean } | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("tunnel_shares")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  const row = data as ShareRow | null;
  if (!row) return null;
  if (row.user_id === userId) return { row, mine: true };
  if (row.kind !== "share" || !row.name || teamIds.length === 0) return null;
  const { data: name, error: nameError } = await admin
    .from("tunnel_names")
    .select("team_id")
    .eq("name", row.name)
    .maybeSingle();
  if (nameError) throw nameError;
  if (name?.team_id && teamIds.includes(name.team_id)) return { row, mine: false };
  return null;
}
