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
  now = Date.now()
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
  };
}

/** The tunnel plan of an account, or null when it is gone. */
export async function tunnelPlanOf(userId: string, now = Date.now()): Promise<TunnelPlan | null> {
  const admin = createAdminClient();
  const [{ data: user, error: userError }, { data: memberships, error: teamError }] =
    await Promise.all([
      admin
        .from("users")
        .select("plan, paid_since, tunnel_notice_lifted")
        .eq("id", userId)
        .maybeSingle(),
      admin
        .from("team_members")
        .select("team_id, teams(subscription_status, business, paid_since)")
        .eq("user_id", userId),
    ]);
  if (userError) throw userError;
  if (teamError) throw teamError;
  if (!user) return null;

  const own = (user.plan === "pro" || user.plan === "business" ? user.plan : "free") as PlanKey;
  const candidates: Candidate[] = [{ key: own, teamId: null, paidSince: user.paid_since }];
  const teamIds: string[] = [];
  for (const m of (memberships ?? []) as unknown as {
    team_id: string;
    teams: {
      subscription_status: string | null;
      business: boolean;
      paid_since: string | null;
    } | null;
  }[]) {
    teamIds.push(m.team_id);
    if (m.teams?.subscription_status)
      candidates.push({
        key: m.teams.business ? "team_business" : "team",
        teamId: m.team_id,
        paidSince: m.teams.paid_since,
      });
  }
  return chooseTunnelPlan(candidates, user.tunnel_notice_lifted, teamIds, now);
}

/** What a plan without reserved names says when one is asked for. */
export function namesUpsell(plan: TunnelPlan): string {
  return `${plan.label} shares get a random name. Reserved names come with Pro and Business.`;
}
