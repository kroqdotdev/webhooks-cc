import { authenticateSessionRequest } from "@/lib/api-auth";
import { PolarConfigError } from "@/lib/polar";
import { BillingActionError, cancelSubscriptionForUser } from "@/lib/supabase/billing";

export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  try {
    await cancelSubscriptionForUser(auth.userId);
    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof BillingActionError && error.code === "no_subscription") {
      return Response.json({ error: error.message }, { status: 409 });
    }

    if (error instanceof PolarConfigError) {
      console.error("Billing cancel misconfigured:", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }

    console.error("Billing cancel failed:", error);
    return Response.json({ error: "Failed to cancel subscription" }, { status: 500 });
  }
}
