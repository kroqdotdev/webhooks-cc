import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { loggablePolarError, PolarConfigError } from "@/lib/polar";
import { BillingActionError, changePlanForUser } from "@/lib/supabase/billing";
import { reportError } from "@/lib/observability";

const STATUS: Record<string, number> = {
  no_subscription: 409,
  plan_ending: 409,
  not_offered: 400,
  unchanged: 409,
};

/**
 * POST /api/billing/change-plan { plan: "pro" | "business", interval: "month" | "year" }:
 * moves a paying account to another plan. Up applies now (the period
 * restarts and the new price is charged, less the unused time); down at the
 * renewal. Takes a session, never an API key.
 */
export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // Refused below.
  }
  const { plan, interval } = body;
  if ((plan !== "pro" && plan !== "business") || (interval !== "month" && interval !== "year")) {
    return Response.json({ error: "Give a plan and an interval" }, { status: 400 });
  }

  try {
    const result = await changePlanForUser(auth.userId, plan, interval);
    await auditUserAction(request, auth.userId, {
      action: "billing.plan_changed",
      status: 200,
      metadata: { plan, interval, applied: result.applied },
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof BillingActionError) {
      const status = STATUS[error.code] ?? 400;
      await auditUserAction(request, auth.userId, {
        action: "billing.plan_changed",
        status,
        reason: error.message,
        metadata: { plan, interval },
      });
      return Response.json({ error: error.message, code: error.code }, { status });
    }
    await auditUserAction(request, auth.userId, {
      action: "billing.plan_changed",
      status: 500,
      metadata: { plan, interval },
    });
    if (error instanceof PolarConfigError) {
      reportError("Plan change misconfigured", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }
    reportError("Plan change failed", loggablePolarError(error));
    return Response.json({ error: "Could not change the plan" }, { status: 500 });
  }
}
