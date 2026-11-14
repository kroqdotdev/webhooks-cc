import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { askForBillingChange } from "@/lib/billing/ask";
import { loggablePolarError, PolarConfigError } from "@/lib/polar";
import { BillingActionError, resubscribeForUser } from "@/lib/supabase/billing";
import { reportError } from "@/lib/observability";

export async function POST(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  // An API key or agent token: the owner approves it first (202).
  const asked = await askForBillingChange(request, auth, null, { kind: "resubscribe" });
  if (asked) return asked;

  try {
    await resubscribeForUser(auth.userId);
    await auditUserAction(request, auth.userId, {
      action: "billing.subscription_resumed",
      status: 200,
    });
    return Response.json({ success: true });
  } catch (error) {
    if (
      error instanceof BillingActionError &&
      (error.code === "no_subscription" || error.code === "not_scheduled")
    ) {
      await auditUserAction(request, auth.userId, {
        action: "billing.subscription_resumed",
        status: 409,
        reason: error.message,
      });
      return Response.json({ error: error.message }, { status: 409 });
    }

    await auditUserAction(request, auth.userId, {
      action: "billing.subscription_resumed",
      status: 500,
    });

    if (error instanceof PolarConfigError) {
      reportError("Billing resubscribe misconfigured", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }

    reportError("Billing resubscribe failed", loggablePolarError(error));
    return Response.json({ error: "Failed to reactivate subscription" }, { status: 500 });
  }
}
