import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import { applyRateLimitHeaders, checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { sharingOff, tunnelConfig } from "@/lib/tunnels/config";
import { apiLimits, apiUsage, sharesFor } from "@/lib/tunnels/listing";
import { tunnelPlanOf } from "@/lib/tunnels/plan";
import { usageOf } from "@/lib/tunnels/usage";

const READ_LIMIT = 120;
const READ_WINDOW_MS = 60_000;

/**
 * The account's `whk share` previews and `whk tunnel --live` sessions (live
 * ones, then the latest that ended), its teams' live previews, this month's
 * shared data, and the plan's limits. `?state=live` or `?state=ended` narrows.
 */
export async function GET(request: Request) {
  if (!tunnelConfig()) return sharingOff();
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const rateLimit = await checkRateLimitByKeyWithInfo(
    `shares-read:${auth.userId}`,
    READ_LIMIT,
    READ_WINDOW_MS
  );
  if (rateLimit.response) return rateLimit.response;

  const raw = new URL(request.url).searchParams.get("state");
  if (raw !== null && raw !== "live" && raw !== "ended")
    return Response.json({ error: "state is live or ended" }, { status: 400 });

  try {
    const plan = await tunnelPlanOf(auth.userId);
    if (!plan) return Response.json({ error: "Account not found" }, { status: 404 });
    const [shares, usage] = await Promise.all([
      sharesFor(auth.userId, plan, raw),
      usageOf(plan, auth.userId),
    ]);
    return applyRateLimitHeaders(
      Response.json({ shares, usage: apiUsage(usage), limits: apiLimits(plan) }),
      rateLimit
    );
  } catch (error) {
    reportError("Failed to list shares", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
