import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { loggablePolarError, PolarConfigError } from "@/lib/polar";
import { BillingActionError, cancelSubscriptionForUser } from "@/lib/supabase/billing";

export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  try {
    await cancelSubscriptionForUser(auth.userId);
    await auditUserAction(request, auth.userId, {
      action: "billing.subscription_canceled",
      status: 200,
    });
    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof BillingActionError && error.code === "no_subscription") {
      await auditUserAction(request, auth.userId, {
        action: "billing.subscription_canceled",
        status: 409,
        reason: error.message,
      });
      return Response.json({ error: error.message }, { status: 409 });
    }

    await auditUserAction(request, auth.userId, {
      action: "billing.subscription_canceled",
      status: 500,
    });

    if (error instanceof PolarConfigError) {
      console.error("Billing cancel misconfigured:", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }

    console.error("Billing cancel failed:", loggablePolarError(error));
    return Response.json({ error: "Failed to cancel subscription" }, { status: 500 });
  }
}
