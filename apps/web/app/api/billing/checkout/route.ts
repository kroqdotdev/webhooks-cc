import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { loggablePolarError, PolarConfigError } from "@/lib/polar";
import { BillingActionError, createCheckoutForUser } from "@/lib/supabase/billing";

export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  try {
    const url = await createCheckoutForUser(auth.userId);
    await auditUserAction(request, auth.userId, {
      action: "billing.checkout_started",
      status: 200,
    });
    return Response.json({ url });
  } catch (error) {
    if (error instanceof BillingActionError && error.code === "already_pro") {
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
      console.error("Billing checkout misconfigured:", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }

    console.error("Billing checkout failed:", loggablePolarError(error));
    return Response.json({ error: "Failed to start checkout" }, { status: 500 });
  }
}
