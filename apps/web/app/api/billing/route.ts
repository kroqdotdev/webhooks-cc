import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { getBillingSummary } from "@/lib/billing/summary";
import { reportError } from "@/lib/observability";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * GET /api/billing: the plan, its subscription and add-ons, and every team's,
 * for any key of the account or a session (lib/billing/summary.ts). Changes
 * stay session-only routes under /api/billing/*.
 */
export async function GET(request: Request) {
  const rateLimited = await checkRateLimit(request, "billing-read", 60);
  if (rateLimited) return rateLimited;

  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  try {
    const summary = await getBillingSummary(auth.userId);
    if (!summary) return Response.json({ error: "Account not found" }, { status: 404 });
    return Response.json(summary);
  } catch (err) {
    reportError("GET /api/billing failed", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
