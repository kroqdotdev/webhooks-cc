import { authenticateSessionRequest } from "@/lib/api-auth";
import { PolarConfigError } from "@/lib/polar";
import { BillingActionError, createCheckoutForUser } from "@/lib/supabase/billing";

export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  try {
    const url = await createCheckoutForUser(auth.userId);
    return Response.json({ url });
  } catch (error) {
    if (error instanceof BillingActionError && error.code === "already_pro") {
      return Response.json({ error: error.message }, { status: 409 });
    }

    if (error instanceof PolarConfigError) {
      console.error("Billing checkout misconfigured:", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }

    console.error("Billing checkout failed:", error);
    return Response.json({ error: "Failed to start checkout" }, { status: 500 });
  }
}
