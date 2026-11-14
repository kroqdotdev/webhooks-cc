import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { askForBillingChange } from "@/lib/billing/ask";
import { loggablePolarError, PolarConfigError } from "@/lib/polar";
import {
  BillingActionError,
  changePlanForUser,
  keepCurrentPlanForUser,
} from "@/lib/supabase/billing";
import { reportError } from "@/lib/observability";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

const changePlanBody = z.object({ plan: z.unknown().optional(), interval: z.unknown().optional() });

const STATUS: Record<string, number> = {
  no_subscription: 409,
  plan_ending: 409,
  not_offered: 400,
  unchanged: 409,
};

/**
 * POST /api/billing/change-plan { plan: "pro" | "business", interval: "month" | "year" }:
 * moves a paying account to another plan. A monthly tier up applies now
 * (the difference is charged for the rest of the period, and the extra
 * capacity granted in proportion); anything else at the renewal. DELETE
 * drops a change waiting for the renewal. A session changes it at once; an
 * API key or agent token gets a quoted approval for the owner (202).
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  // A body that cannot be read counts as an empty one, refused below.
  const parsed = await parseJsonBodyWith(request, changePlanBody);
  const body: z.infer<typeof changePlanBody> = "data" in parsed ? parsed.data : {};
  const { plan, interval } = body;
  if ((plan !== "pro" && plan !== "business") || (interval !== "month" && interval !== "year")) {
    return Response.json({ error: "Give a plan and an interval" }, { status: 400 });
  }
  // An API key or agent token: the owner approves the quoted change.
  const asked = await askForBillingChange(request, auth, null, { kind: "plan", plan, interval });
  if (asked) return asked;

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

export async function DELETE(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const asked = await askForBillingChange(request, auth, null, { kind: "keep_plan" });
  if (asked) return asked;

  try {
    await keepCurrentPlanForUser(auth.userId);
    await auditUserAction(request, auth.userId, {
      action: "billing.plan_changed",
      status: 200,
      metadata: { kept: true },
    });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof BillingActionError) {
      const status = STATUS[error.code] ?? 400;
      await auditUserAction(request, auth.userId, {
        action: "billing.plan_changed",
        status,
        reason: error.message,
        metadata: { kept: true },
      });
      return Response.json({ error: error.message, code: error.code }, { status });
    }
    await auditUserAction(request, auth.userId, {
      action: "billing.plan_changed",
      status: 500,
      metadata: { kept: true },
    });
    reportError("Keeping the plan failed", loggablePolarError(error));
    return Response.json({ error: "Could not keep the plan" }, { status: 500 });
  }
}
