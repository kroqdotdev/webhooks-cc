import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { loggablePolarError, PolarConfigError } from "@/lib/polar";
import { BillingActionError, createCustomerPortalForUser } from "@/lib/supabase/billing";
import { reportError } from "@/lib/observability";

/**
 * A link into Polar's customer portal (invoices, receipts, payment method).
 * Session only: the link signs its holder in as the account's Polar
 * customer, so an API key never gets one.
 */
export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  try {
    const url = await createCustomerPortalForUser(auth.userId);
    await auditUserAction(request, auth.userId, { action: "billing.portal_opened", status: 200 });
    return Response.json({ url });
  } catch (error) {
    if (error instanceof BillingActionError && error.code === "no_customer") {
      await auditUserAction(request, auth.userId, {
        action: "billing.portal_opened",
        status: 409,
        reason: error.message,
      });
      return Response.json({ error: error.message }, { status: 409 });
    }

    await auditUserAction(request, auth.userId, { action: "billing.portal_opened", status: 500 });

    if (error instanceof PolarConfigError) {
      reportError("Billing portal misconfigured", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }

    reportError("Billing portal failed", loggablePolarError(error));
    return Response.json({ error: "Could not open billing. Please try again." }, { status: 500 });
  }
}
