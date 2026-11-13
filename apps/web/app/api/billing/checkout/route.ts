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
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

const checkoutBody = z.object({ plan: z.unknown().optional(), interval: z.unknown().optional() });

export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  // { plan?: "pro" | "business", interval?: "month" | "year" }; Pro monthly when left out.
  // An empty body, or one that cannot be read, is Pro, as before.
  const parsed = await parseJsonBodyWith(request, checkoutBody);
  const body: z.infer<typeof checkoutBody> = "data" in parsed ? parsed.data : {};
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
