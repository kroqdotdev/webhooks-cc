import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import {
  CheckoutLinkError,
  createCheckoutLink,
  itemTeamId,
  parseCheckoutItem,
} from "@/lib/billing/checkout-links";
import { describePolarError, loggablePolarError, PolarConfigError } from "@/lib/polar";
import { reportError } from "@/lib/observability";
import { checkRateLimit } from "@/lib/rate-limit";
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
 * The answer for a link that was not made, and the reason to audit: only
 * our own messages, never a Polar error's, whose message embeds the
 * response body.
 */
function errorResponse(error: unknown): { response: Response; reason?: string } {
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
    response: Response.json(
      detail
        ? { error: "Failed to make the checkout link", detail }
        : { error: "Failed to make the checkout link" },
      { status: 500 }
    ),
  };
}

/**
 * POST /api/billing/checkouts: a Polar checkout link for something the
 * account (or a team the caller owns) can buy, for an agent to hand to the
 * person, who pays on Polar's page with their own card. Any key of the
 * account, a claimed agent token, or a session; a pre-claim agent token is
 * refused. No approval: nothing is charged until the person pays. The body
 * names what to buy (lib/billing/checkout-links.ts); the answer is 201
 * { checkout } with its url, and GET /api/billing/checkouts/{id} follows it.
 * Every attempt is audited.
 */
export async function POST(request: Request) {
  const rateLimited = await checkRateLimit(request, "billing-checkouts", 20);
  if (rateLimited) return rateLimited;

  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = parseCheckoutItem(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const { item } = parsed;
  const teamId = itemTeamId(item);

  try {
    const checkout = await createCheckoutLink(
      { userId: auth.userId, keyId: auth.keyId, agentRegistrationId: auth.agentRegistrationId },
      item
    );
    await auditUserAction(request, auth.userId, {
      action: "billing.checkout_link_created",
      status: 201,
      teamId,
      targetId: checkout.id,
      metadata: { ...item },
    });
    return Response.json({ checkout }, { status: 201 });
  } catch (error) {
    const { response, reason } = errorResponse(error);
    await auditUserAction(request, auth.userId, {
      action: "billing.checkout_link_created",
      status: response.status,
      reason,
      teamId,
      metadata: { ...item },
    });
    return response;
  }
}
