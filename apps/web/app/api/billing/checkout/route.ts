import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import {
  loggablePolarError,
  PolarConfigError,
  type BillingInterval,
  type PaidPlan,
} from "@/lib/polar";
import { BillingActionError, createCheckoutForUser } from "@/lib/supabase/billing";
import { reportError } from "@/lib/observability";

export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  // { plan?: "pro" | "business", interval?: "month" | "year" }; Pro monthly when left out.
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // An empty body is Pro, as before.
  }
  const plan = body.plan === undefined ? "pro" : body.plan;
  const interval = body.interval === undefined ? "month" : body.interval;
  if ((plan !== "pro" && plan !== "business") || (interval !== "month" && interval !== "year")) {
    return Response.json({ error: "Unknown plan or interval" }, { status: 400 });
  }

  try {
    const url = await createCheckoutForUser(
      auth.userId,
      plan as PaidPlan,
      interval as BillingInterval
    );
    await auditUserAction(request, auth.userId, {
      action: "billing.checkout_started",
      status: 200,
      metadata: { plan, interval },
    });
    return Response.json({ url });
  } catch (error) {
    if (
      error instanceof BillingActionError &&
      ["already_pro", "already_subscribed", "not_offered"].includes(error.code)
    ) {
      await auditUserAction(request, auth.userId, {
        action: "billing.checkout_started",
        status: 409,
        reason: error.message,
      });
      return Response.json({ error: error.message }, { status: 409 });
    }

    await auditUserAction(request, auth.userId, {
      action: "billing.checkout_started",
      status: 500,
    });

    if (error instanceof PolarConfigError) {
      reportError("Billing checkout misconfigured", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }

    reportError("Billing checkout failed", loggablePolarError(error));
    return Response.json({ error: "Failed to start checkout" }, { status: 500 });
  }
}
