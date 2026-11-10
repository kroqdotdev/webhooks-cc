import { ENTITLEMENTS, type Entitlements, type PlanKey } from "@/lib/entitlements";
import { createAdminClient } from "@/lib/supabase/admin";

/*
 * Which plan an account's tunnels follow: the best of its own plan and the
 * plan of every team it belongs to whose subscription is live (Teams gives
 * Pro's numbers, Team Business gives Business's). Limits count per person.
 *
 * The visitor notice shows on Free previews, and on a paid account's previews
 * for 7 days after that plan's account (or team) first paid, unless staff
 * lifted it (users.tunnel_notice_lifted). A stolen card buys a phisher a
 * working link at once; behind the notice it is worth much less, while a real
 * customer barely notices it.
 */

export const NEW_PAID_NOTICE_DAYS = 7;

const LABELS: Record<PlanKey, string> = {
  free: "Free",
  pro: "Pro",
  business: "Business",
  team: "Teams",
  team_business: "Team Business",
};

export interface TunnelPlan {
  key: PlanKey;
  label: string;
  limits: Entitlements;
  /** Visitors see the notice before the preview. */
  notice: boolean;
  /** The team whose plan this is, when it is one. */
  teamId: string | null;
  /** Every team the account belongs to, live or not. */
  teamIds: string[];
  /**
   * The teams whose subscription is live: only their names may be shared
   * under or have their passwords changed by their members.
   */
  activeTeamIds: string[];
}

interface Candidate {
  key: PlanKey;
  teamId: string | null;
  paidSince: string | null;
}

/** Pure: the best candidate and whether its previews show the notice. */
export function chooseTunnelPlan(
  candidates: Candidate[],
  lifted: boolean,
  teamIds: string[],
  now = Date.now(),
  activeTeamIds: string[] = candidates.flatMap((c) => (c.teamId ? [c.teamId] : []))
): TunnelPlan {
  const rank = (c: Candidate) => {
    const e = ENTITLEMENTS[c.key];
    return e.shareDataGb * 1_000 + e.shareSlots;
  };
  const best = candidates.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  const paidAt = best.paidSince ? Date.parse(best.paidSince) : NaN;
  const fresh = Number.isNaN(paidAt) || now - paidAt < NEW_PAID_NOTICE_DAYS * 86_400_000;
  return {
    key: best.key,
    label: LABELS[best.key],
    limits: ENTITLEMENTS[best.key],
    notice: best.key === "free" ? true : !lifted && fresh,
    teamId: best.teamId,
    teamIds,
    activeTeamIds,
  };
}

/** The tunnel plan of an account, or null when it is gone. */
export async function tunnelPlanOf(userId: string, now = Date.now()): Promise<TunnelPlan | null> {
  return (await tunnelPlansOf([userId], now)).get(userId) ?? null;
}

type Membership = {
  user_id: string;
  team_id: string;
  teams: {
    subscription_status: string | null;
    business: boolean;
    paid_since: string | null;
  } | null;
};

/**
 * The tunnel plans of many accounts in two queries (the edge's sync asks for
 * every account past 1 GB at once). Accounts that are gone are left out.
 */
export async function tunnelPlansOf(
  userIds: string[],
  now = Date.now()
): Promise<Map<string, TunnelPlan>> {
  const plans = new Map<string, TunnelPlan>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return plans;
  const admin = createAdminClient();
  const [{ data: users, error: userError }, { data: memberships, error: teamError }] =
    await Promise.all([
      admin.from("users").select("id, plan, paid_since, tunnel_notice_lifted").in("id", ids),
      admin
        .from("team_members")
        .select("user_id, team_id, teams(subscription_status, business, paid_since)")
        .in("user_id", ids),
    ]);
  if (userError) throw userError;
  if (teamError) throw teamError;
  const teamsOf = new Map<string, Membership[]>();
  for (const m of (memberships ?? []) as unknown as Membership[])
    teamsOf.set(m.user_id, [...(teamsOf.get(m.user_id) ?? []), m]);

  for (const user of users ?? []) {
    const own = (user.plan === "pro" || user.plan === "business" ? user.plan : "free") as PlanKey;
    const candidates: Candidate[] = [{ key: own, teamId: null, paidSince: user.paid_since }];
    const teamIds: string[] = [];
    for (const m of teamsOf.get(user.id) ?? []) {
      teamIds.push(m.team_id);
      if (m.teams?.subscription_status)
        candidates.push({
          key: m.teams.business ? "team_business" : "team",
          teamId: m.team_id,
          paidSince: m.teams.paid_since,
        });
    }
    const activeTeamIds = candidates.flatMap((c) => (c.teamId ? [c.teamId] : []));
    plans.set(
      user.id,
      chooseTunnelPlan(candidates, user.tunnel_notice_lifted, teamIds, now, activeTeamIds)
    );
  }
  return plans;
}

/** What a plan without reserved names says when one is asked for. */
export function namesUpsell(plan: TunnelPlan): string {
  return `${plan.label} shares get a random name. Reserved names come with Pro and Business.`;
}
