import { createAdminClient } from "@/lib/supabase/admin";
import { grantActive } from "@/lib/support/shared";

/**
 * Account metadata for staff: what answers most support questions without
 * opening anyone's captured data. Request and email contents are never read
 * here; they need a grant (lib/ops/view.ts).
 */

export interface AccountSummary {
  id: string;
  email: string;
  name: string | null;
  plan: string;
  createdAt: string;
}

/** Finds accounts by email (substring), exact id, or endpoint slug. */
export async function searchAccounts(query: string): Promise<AccountSummary[]> {
  const admin = createAdminClient();
  const q = query.trim();
  if (!q) {
    const { data, error } = await admin
      .from("users")
      .select("id, email, name, plan, created_at")
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw error;
    return (data ?? []).map(toSummary);
  }

  const ids = new Set<string>();
  if (/^[0-9a-f-]{36}$/i.test(q)) ids.add(q.toLowerCase());
  const { data: bySlug } = await admin
    .from("endpoints")
    .select("user_id")
    .eq("slug", q)
    .not("user_id", "is", null)
    .limit(1);
  for (const row of bySlug ?? []) if (row.user_id) ids.add(row.user_id);

  // ILIKE wildcards in the query are matched literally.
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { data: byEmail, error } = await admin
    .from("users")
    .select("id, email, name, plan, created_at")
    .ilike("email", pattern)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw error;
  const results = new Map((byEmail ?? []).map((row) => [row.id, toSummary(row)]));

  const extra = [...ids].filter((id) => !results.has(id));
  if (extra.length > 0) {
    const { data } = await admin
      .from("users")
      .select("id, email, name, plan, created_at")
      .in("id", extra);
    for (const row of data ?? []) results.set(row.id, toSummary(row));
  }
  return [...results.values()];
}

function toSummary(row: {
  id: string;
  email: string;
  name: string | null;
  plan: string;
  created_at: string;
}): AccountSummary {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    plan: row.plan,
    createdAt: row.created_at,
  };
}

export interface AccountDetail extends AccountSummary {
  homeSite: string;
  internal: boolean;
  staff: boolean;
  lastSignInAt: string | null;
  twoFactor: boolean;
  billing: {
    subscriptionStatus: string | null;
    interval: string | null;
    periodEnd: string | null;
    billingPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    pendingPlan: string | null;
    requestsUsed: number;
    requestLimit: number;
    blockRequests: number;
    overageActive: boolean;
  };
  teams: { id: string; name: string; role: string; subscribed: boolean; business: boolean }[];
  endpoints: {
    id: string;
    slug: string;
    name: string | null;
    site: string;
    createdAt: string;
    captured7d: number;
    rejected7d: number;
    failedDeliveries7d: number;
    lastEmailAt: string | null;
  }[];
  apiKeys: number;
  agents: number;
  activity: { action: string; outcome: string; via: string | null; at: string }[];
  tickets: { id: string; number: number; subject: string; status: string; lastMessageAt: string }[];
  /** The ticket whose grant lets staff view contents now, if any. */
  activeGrant: { ticketId: string; number: number } | null;
}

export async function accountDetail(userId: string): Promise<AccountDetail | null> {
  const admin = createAdminClient();
  const { data: user, error } = await admin
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!user) return null;

  const since = new Date(Date.now() - 7 * 86_400_000);
  const sinceDay = since.toISOString().slice(0, 10);

  const [authUser, staffRow, memberships, endpoints, stats, keys, audit, tickets] =
    await Promise.all([
      admin.auth.admin.getUserById(userId),
      admin.from("staff").select("user_id").eq("user_id", userId).maybeSingle(),
      admin.from("team_members").select("team_id, role").eq("user_id", userId),
      admin
        .from("endpoints")
        .select("id, slug, name, site, created_at, last_email_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(200),
      admin
        .from("endpoint_daily_stats")
        .select("endpoint_id, captured, quota_rejected")
        .eq("user_id", userId)
        .gte("day", sinceDay),
      admin
        .from("api_keys")
        .select("id, is_agent_issued, agent_registration_id")
        .eq("user_id", userId),
      admin
        .from("audit_events")
        .select("action, outcome, via, occurred_at")
        .eq("actor_user_id", userId)
        .order("occurred_at", { ascending: false })
        .limit(30),
      admin
        .from("support_tickets")
        .select("id, number, subject, status, closed_at, access_granted, last_message_at")
        .eq("user_id", userId)
        .order("last_message_at", { ascending: false })
        .limit(50),
    ]);

  const teamIds = (memberships.data ?? []).map((row) => row.team_id);
  const teamRows = teamIds.length
    ? ((
        await admin
          .from("teams")
          .select("id, name, subscription_status, business")
          .in("id", teamIds)
      ).data ?? [])
    : [];

  const endpointIds = (endpoints.data ?? []).map((row) => row.id);
  const failed = new Map<string, number>();
  if (endpointIds.length > 0) {
    const { data } = await admin
      .from("email_deliveries")
      .select("endpoint_id")
      .in("endpoint_id", endpointIds)
      .eq("status", "failed")
      .gte("created_at", since.toISOString())
      .limit(5000);
    for (const row of data ?? [])
      failed.set(row.endpoint_id, (failed.get(row.endpoint_id) ?? 0) + 1);
  }
  const captured = new Map<string, { captured: number; rejected: number }>();
  for (const row of stats.data ?? []) {
    const entry = captured.get(row.endpoint_id) ?? { captured: 0, rejected: 0 };
    entry.captured += row.captured;
    entry.rejected += row.quota_rejected;
    captured.set(row.endpoint_id, entry);
  }

  const grantTicket = (tickets.data ?? []).find((ticket) => grantActive(ticket));
  const factors = authUser.data.user?.factors ?? [];

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan,
    createdAt: user.created_at,
    homeSite: user.home_site,
    internal: user.internal ?? false,
    staff: !!staffRow.data,
    lastSignInAt: authUser.data.user?.last_sign_in_at ?? null,
    twoFactor: factors.some((factor) => factor.status === "verified"),
    billing: {
      subscriptionStatus: user.subscription_status,
      interval: user.billing_interval,
      periodEnd: user.period_end,
      billingPeriodEnd: user.billing_period_end,
      cancelAtPeriodEnd: user.cancel_at_period_end,
      pendingPlan: user.pending_plan,
      requestsUsed: user.requests_used,
      requestLimit: user.request_limit,
      blockRequests: user.block_requests ?? 0,
      overageActive: user.overage_active ?? false,
    },
    teams: teamRows.map((team) => ({
      id: team.id,
      name: team.name,
      role: memberships.data?.find((row) => row.team_id === team.id)?.role ?? "member",
      subscribed: team.subscription_status !== null,
      business: team.business,
    })),
    endpoints: (endpoints.data ?? []).map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      site: row.site,
      createdAt: row.created_at,
      captured7d: captured.get(row.id)?.captured ?? 0,
      rejected7d: captured.get(row.id)?.rejected ?? 0,
      failedDeliveries7d: failed.get(row.id) ?? 0,
      lastEmailAt: row.last_email_at,
    })),
    apiKeys: (keys.data ?? []).filter((key) => !key.agent_registration_id).length,
    agents: new Set(
      (keys.data ?? []).map((key) => key.agent_registration_id).filter((id): id is string => !!id)
    ).size,
    activity: (audit.data ?? []).map((row) => ({
      action: row.action,
      outcome: row.outcome,
      via: row.via,
      at: row.occurred_at,
    })),
    tickets: (tickets.data ?? []).map((ticket) => ({
      id: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      status: ticket.status,
      lastMessageAt: ticket.last_message_at,
    })),
    activeGrant: grantTicket ? { ticketId: grantTicket.id, number: grantTicket.number } : null,
  };
}
