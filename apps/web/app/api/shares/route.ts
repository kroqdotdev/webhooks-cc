import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import { applyRateLimitHeaders, checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { sharingOff, tunnelConfig } from "@/lib/tunnels/config";
import { sharingSuspended } from "@/lib/tunnels/accounts";
import { apiLimits, apiUsage, shareHints, sharesFor } from "@/lib/tunnels/listing";
import { namesView } from "@/lib/tunnels/names";
import { tunnelPlanOf } from "@/lib/tunnels/plan";
import { usageOf } from "@/lib/tunnels/usage";

const READ_LIMIT = 120;
const READ_WINDOW_MS = 60_000;

/**
 * The account's `whk share` previews and `whk tunnel --live` sessions (live
 * ones, then the latest that ended), its teams' live previews, this month's
 * shared data, the plan's limits, where it stands on reserved names, whether
 * sharing is suspended, and `hints`: what it can do next, as commands, so an
 * agent never needs the dashboard. `?state=live` or `?state=ended` narrows.
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
    const [shares, usage, suspended, view] = await Promise.all([
      sharesFor(auth.userId, plan, raw),
      usageOf(plan, auth.userId),
      sharingSuspended(auth.userId),
      namesView(auth.userId, plan),
    ]);
    const names = {
      limit: view.own.limit,
      used: view.own.used,
      usable: view.names.filter((n) => n.usable).length,
    };
    // Counted from the live list itself when it was asked for; otherwise
    // the ended list says nothing about slots.
    const live =
      raw === "ended" ? null : shares.filter((s) => s.mine && s.kind === "share" && !s.endedAt);
    return applyRateLimitHeaders(
      Response.json({
        shares,
        usage: apiUsage(usage),
        limits: apiLimits(plan),
        names,
        suspended,
        hints: shareHints({
          plan,
          usage,
          suspended,
          liveShares: live?.length ?? 0,
          names,
        }),
      }),
      rateLimit
    );
  } catch (error) {
    reportError("Failed to list shares", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
