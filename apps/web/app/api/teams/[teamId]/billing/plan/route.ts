import { checkRateLimit } from "@/lib/rate-limit";
import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser, authenticateSessionRequest } from "@/lib/api-auth";
import { loggablePolarError, PolarConfigError } from "@/lib/polar";
import { reportError } from "@/lib/observability";
import {
  changeTeamPlan,
  keepTeamPlan,
  quoteTeamPlanChange,
  TeamBillingError,
} from "@/lib/supabase/team-billing";
import { ERROR_STATUS, isInterval, isTeamPlan } from "../shared";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

/**
 * Quotes a plan change for the confirmation dialog:
 * `GET ...?plan=team_business&interval=year`. The owner only, with a session.
 */
// A read: any key of the account, or a session. Changes (POST) take a session.
export async function GET(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  // Each quote asks Polar, so keys get a limit of their own.
  const rateLimited = await checkRateLimit(request, "team-billing-quote", 20);
  if (rateLimited) return rateLimited;
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;
  const query = new URL(request.url).searchParams;
  const plan = query.get("plan");
  const interval = query.get("interval") ?? "month";
  if (!isTeamPlan(plan) || !isInterval(interval)) {
    return Response.json({ error: "Unknown plan" }, { status: 400 });
  }

  try {
    return Response.json(await quoteTeamPlanChange(auth.userId, teamId, plan, interval));
  } catch (error) {
    if (error instanceof TeamBillingError) {
      return Response.json({ error: error.message }, { status: ERROR_STATUS[error.code] ?? 400 });
    }
    if (error instanceof PolarConfigError) {
      reportError("Team plan quote misconfigured", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }
    reportError("Team plan quote failed", loggablePolarError(error));
    return Response.json({ error: "Could not price the plan change" }, { status: 500 });
  }
}

const planBody = z.object({
  plan: z.unknown().optional(),
  interval: z.unknown().optional(),
  action: z.unknown().optional(),
});

/**
 * POST /api/teams/{teamId}/billing/plan
 * { plan: "team" | "team_business", interval: "month" | "year" } changes the
 * team's plan: an upgrade at once (charged now), a downgrade at the renewal.
 * { action: "keep" } drops a change waiting for the renewal. Answers
 * { applied: "now" | "renewal" }, or 204 for "keep". The owner only, with a
 * session.
 */
export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;
  // A body that cannot be read counts as an empty one.
  const parsed = await parseJsonBodyWith(request, planBody);
  const body: z.infer<typeof planBody> = "data" in parsed ? parsed.data : {};

  const keep = body.action === "keep";
  const plan = body.plan;
  const interval = body.interval ?? "month";
  if (!keep && (!isTeamPlan(plan) || !isInterval(interval))) {
    return Response.json({ error: "Unknown plan" }, { status: 400 });
  }
  const action = keep ? "team.plan_kept" : "team.plan_changed";
  const metadata = keep ? {} : { plan, interval };

  try {
    if (keep) {
      await keepTeamPlan(auth.userId, teamId);
      await auditUserAction(request, auth.userId, { action, status: 204, teamId, metadata });
      return new Response(null, { status: 204 });
    }
    const result = await changeTeamPlan(
      auth.userId,
      teamId,
      plan as "team" | "team_business",
      interval as "month" | "year"
    );
    await auditUserAction(request, auth.userId, {
      action,
      status: 200,
      teamId,
      metadata: { ...metadata, applied: result.applied },
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof TeamBillingError) {
      const status = ERROR_STATUS[error.code] ?? 400;
      await auditUserAction(request, auth.userId, {
        action,
        status,
        reason: error.message,
        teamId,
        metadata: { ...metadata, code: error.code },
      });
      return Response.json({ error: error.message }, { status });
    }

    await auditUserAction(request, auth.userId, { action, status: 500, teamId, metadata });
    if (error instanceof PolarConfigError) {
      reportError("Team plan change misconfigured", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }
    reportError("Team plan change failed", loggablePolarError(error));
    return Response.json({ error: "Failed to change the plan" }, { status: 500 });
  }
}
