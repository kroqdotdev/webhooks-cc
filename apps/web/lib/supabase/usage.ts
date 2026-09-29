import { createAdminClient } from "./admin";
import type { UserPlan } from "./api-keys";

export interface UsageInfo {
  used: number;
  limit: number;
  remaining: number;
  plan: UserPlan;
  periodEnd: number | null;
  /**
   * Owned endpoints shared with a subscribed team. capture_webhook() bills
   * those to the team, so they keep capturing when this quota is used up.
   */
  teamBilledEndpoints: number;
}

export async function getUsageForUser(userId: string): Promise<UsageInfo | null> {
  const admin = createAdminClient();
  const { data: user, error } = await admin
    .from("users")
    .select("plan, requests_used, request_limit, period_end")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!user || (user.plan !== "free" && user.plan !== "pro")) {
    return null;
  }

  const { data: teamBilledEndpoints, error: countError } = await admin.rpc(
    "count_team_billed_endpoints",
    { p_user_id: userId }
  );
  if (countError) {
    throw countError;
  }

  const now = Date.now();
  const periodEndMs = user.period_end ? Date.parse(user.period_end) : NaN;
  const periodActive = Number.isFinite(periodEndMs) && periodEndMs > now;
  const used = user.plan === "free" && !periodActive ? 0 : user.requests_used;

  return {
    used,
    limit: user.request_limit,
    remaining: Math.max(0, user.request_limit - used),
    plan: user.plan,
    periodEnd: periodActive ? periodEndMs : null,
    teamBilledEndpoints: teamBilledEndpoints ?? 0,
  };
}
