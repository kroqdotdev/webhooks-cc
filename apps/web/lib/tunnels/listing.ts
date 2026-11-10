import { getWebhookUrl } from "@/lib/constants";
import { createAdminClient } from "@/lib/supabase/admin";
import { previewUrl } from "./config";
import { namesUpsell, type TunnelPlan } from "./plan";
import type { ShareRow } from "./shares";
import { foldEnded } from "./fold-ended";
import { describeEnding } from "./stops";
import { overMessage, type MonthUsage } from "./usage";

/*
 * Runs and limits as the API shows them (GET /api/shares): the account's own
 * runs, the live previews teammates run under the names of a team the account
 * is in, which any member may stop, and teammates' live tunnels on the
 * account's own endpoints, which their owner may stop. A run that reconnected
 * (the tunnel dropped, the edge restarted) is one run, not one per connection.
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
  /** Whether visitors see the notice page before the preview. */
  notice: boolean;
  mine: boolean;
  startedBy: { id: string; email: string } | null;
}

export interface ApiTunnelUsage {
  month: string;
  bytes: number;
  limitBytes: number;
  over: boolean;
  resetsAt: string;
  /** Why previews are paused and when they open again, while `over`. */
  message: string | null;
}

export interface ApiTunnelLimits {
  plan: string;
  /** "Pro", "Team Business": the plan's name as people read it. */
  label: string;
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
    message: u.over ? overMessage(u) : null,
  };
}

export function apiLimits(plan: TunnelPlan): ApiTunnelLimits {
  return {
    plan: plan.key,
    label: plan.label,
    shares: plan.limits.shareSlots,
    reservedNames: plan.limits.reservedNames,
    sessionMinutes: plan.limits.shareSessionMinutes,
    dataGb: plan.limits.shareDataGb,
    passwords: plan.limits.sharePasswords,
    notice: plan.notice,
  };
}

/** Where an account stands on reserved names (GET /api/tunnel-names lists them). */
export interface ApiNamesSummary {
  /** One's own names against the plan. */
  limit: number;
  used: number;
  /** Names one may share under now, own and teams'. */
  usable: number;
}

/**
 * What an account can do next, as commands an agent can run: the API answer
 * carries them so nothing needs the dashboard. Pure.
 */
export function shareHints(input: {
  plan: TunnelPlan;
  usage: MonthUsage;
  suspended: boolean;
  liveShares: number;
  names: ApiNamesSummary;
}): string[] {
  const { plan, usage, suspended, liveShares, names } = input;
  if (suspended)
    return [
      "Sharing is suspended on this account. Write to support@webhooks.cc if this is a mistake.",
    ];
  const hints: string[] = [];
  if (usage.over) hints.push(overMessage(usage));
  if (liveShares >= plan.limits.shareSlots)
    hints.push(
      `${plan.label} allows ${plan.limits.shareSlots} ${plan.limits.shareSlots === 1 ? "preview" : "previews"} at a time, and that many are running. Stop one with whk shares stop <id or name> to start another.`
    );
  else hints.push("Share a local port with whk share <port>; it prints the link.");
  if (plan.limits.reservedNames === 0) hints.push(namesUpsell(plan));
  else if (names.used < names.limit)
    hints.push(
      "Keep a link the same every time with whk names reserve <name>, then whk share <port> --name <name>."
    );
  if (plan.limits.sharePasswords)
    hints.push("Put a password on a preview with whk share <port> --password.");
  if (plan.limits.shareSessionMinutes !== null)
    hints.push(
      `${plan.label} previews last ${plan.limits.shareSessionMinutes} minutes; start one again with whk share <port> for a new link.`
    );
  hints.push(
    "Send webhooks to a local app and give the sender its real answer with whk tunnel <port> --live."
  );
  return hints;
}

const COLUMNS =
  "id, kind, user_id, name, endpoint_id, free, notice, client, key_id, instance, client_address, started_at, expires_at, ended_at, end_reason, password_hash, password_version, bytes, requests";

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

/** Teammates' live tunnels on the account's own endpoints. */
async function liveOnOwnEndpoints(userId: string): Promise<ShareRow[]> {
  const { data, error } = await createAdminClient()
    .from("tunnel_shares")
    .select(`${COLUMNS}, endpoints!inner(user_id)`)
    .eq("kind", "live")
    .is("ended_at", null)
    .eq("endpoints.user_id", userId)
    .neq("user_id", userId);
  if (error) throw error;
  return (data ?? []) as unknown as ShareRow[];
}

/**
 * The runs an account sees: its live ones, its latest `limit` ended ones, its
 * teams' live previews, and teammates' live tunnels on its own endpoints.
 * `state` narrows to live or ended.
 */
export async function sharesFor(
  userId: string,
  plan: TunnelPlan,
  state: "live" | "ended" | null,
  limit = 30
): Promise<ApiShare[]> {
  const admin = createAdminClient();
  const [live, ended, team, onMine] = await Promise.all([
    // Live runs are needed for the ended list too: a run live again is not ended.
    admin
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
          .order("ended_at", { ascending: false })
          // Reconnects fold into one run; read enough rows for `limit` runs.
          .limit(limit * 5),
    state === "ended" ? Promise.resolve([] as ShareRow[]) : teamLiveShares(userId, plan.teamIds),
    state === "ended" ? Promise.resolve([] as ShareRow[]) : liveOnOwnEndpoints(userId),
  ]);
  if (live.error) throw live.error;
  if (ended.error) throw ended.error;
  const liveRows = (live.data ?? []) as ShareRow[];
  const liveInstances = new Set(
    liveRows.filter((r) => r.instance).map((r) => `${r.user_id}:${r.instance}`)
  );
  const rows = [
    ...(state === "ended" ? [] : liveRows),
    ...team,
    ...onMine,
    ...foldEnded((ended.data ?? []) as ShareRow[], liveInstances, limit),
  ];
  return describe(rows, userId);
}

/** The API's shape for rows, with who started each and the endpoints' slugs. */
export async function describe(rows: ShareRow[], userId: string): Promise<ApiShare[]> {
  if (rows.length === 0) return [];
  const admin = createAdminClient();
  const userIds = [...new Set(rows.map((r) => r.user_id).filter((x): x is string => !!x))];
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
      notice: r.notice,
      mine: r.user_id === userId,
      // Who started it, for a teammate's run; null for one's own.
      startedBy:
        r.user_id && r.user_id !== userId && emailOf.has(r.user_id)
          ? { id: r.user_id, email: emailOf.get(r.user_id)! }
          : null,
    };
  });
}

/**
 * A run the account may act on: its own, a teammate's live preview under a
 * name of one of the account's teams, or a teammate's live tunnel on one of
 * the account's own endpoints (`owner`). Null otherwise.
 */
export async function shareFor(
  id: string,
  userId: string,
  teamIds: string[]
): Promise<{ row: ShareRow; mine: boolean; owner?: boolean } | null> {
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
  if (row.kind === "live" && row.endpoint_id) {
    const { data: endpoint, error: endpointError } = await admin
      .from("endpoints")
      .select("user_id")
      .eq("id", row.endpoint_id)
      .maybeSingle();
    if (endpointError) throw endpointError;
    return endpoint?.user_id === userId ? { row, mine: false, owner: true } : null;
  }
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
