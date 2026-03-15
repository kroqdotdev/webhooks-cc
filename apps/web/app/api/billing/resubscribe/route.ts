import { authenticateSessionRequest } from "@/lib/api-auth";
import { PolarConfigError } from "@/lib/polar";
import { BillingActionError, resubscribeForUser } from "@/lib/supabase/billing";

export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  try {
    await resubscribeForUser(auth.userId);
    return Response.json({ success: true });
  } catch (error) {
    if (
      error instanceof BillingActionError &&
      (error.code === "no_subscription" || error.code === "not_scheduled")
    ) {
      return Response.json({ error: error.message }, { status: 409 });
    }

    if (error instanceof PolarConfigError) {
      console.error("Billing resubscribe misconfigured:", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }

    console.error("Billing resubscribe failed:", error);
    return Response.json({ error: "Failed to reactivate subscription" }, { status: 500 });
  }
}
