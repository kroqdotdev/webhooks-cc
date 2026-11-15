import { CheckoutLinkError } from "@/lib/billing/checkout-links";
import { describePolarError, loggablePolarError, PolarConfigError } from "@/lib/polar";
import { reportError } from "@/lib/observability";
import { BillingActionError } from "@/lib/supabase/billing";
import { CapacityError } from "@/lib/supabase/capacity-billing";
import { TeamBillingError } from "@/lib/supabase/team-billing";
import { ERROR_STATUS as TEAM_ERROR_STATUS } from "../../teams/[teamId]/billing/shared";

const BILLING_ERROR_STATUS: Record<string, number> = {
  already_pro: 409,
  already_subscribed: 409,
  not_offered: 404,
  user_not_found: 404,
};

/**
 * The answer for a checkout link that was not made or not opened, and the
 * reason to audit: only our own messages, never a Polar error's, whose
 * message embeds the response body.
 */
export function checkoutErrorResponse(
  error: unknown,
  failed: string
): { response: Response; reason?: string } {
  const refuse = (message: string, status: number, code?: string) => ({
    response: Response.json(code ? { error: message, code } : { error: message }, { status }),
    reason: message,
  });
  if (error instanceof CheckoutLinkError) return refuse(error.message, error.status, error.code);
  if (error instanceof CapacityError) return refuse(error.message, error.status, error.code);
  if (error instanceof TeamBillingError) {
    return refuse(error.message, TEAM_ERROR_STATUS[error.code] ?? 400, error.code);
  }
  if (error instanceof BillingActionError) {
    return refuse(error.message, BILLING_ERROR_STATUS[error.code] ?? 400, error.code);
  }
  if (error instanceof PolarConfigError) {
    reportError("Checkout link misconfigured", error);
    return { response: Response.json({ error: "Billing is not configured" }, { status: 500 }) };
  }
  reportError("Checkout link failed", loggablePolarError(error));
  // Polar's validation detail (an unroutable billing email, say) tells the
  // person why; it is Polar's answer about the request, not a raw error.
  const detail = describePolarError(error);
  return {
    response: Response.json(detail ? { error: failed, detail } : { error: failed }, {
      status: 500,
    }),
  };
}
