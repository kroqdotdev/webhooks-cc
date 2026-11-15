import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { expireCheckoutLink, getCheckoutLink } from "@/lib/billing/checkout-links";
import { loggablePolarError } from "@/lib/polar";
import { reportError } from "@/lib/observability";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkoutErrorResponse } from "../shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/billing/checkouts/{id}: where a checkout link stands (open, paid,
 * expired, or superseded when the webhook undid its purchase as a duplicate:
 * its subscription ended and a refund queued for review) and what it buys, for the person who asked for it, with
 * any of their keys, agents or sessions, and for a team link also the
 * team's owner now, while the asker still owns the team. The link (our
 * page) is only in the answer while it is open; Polar's checkout never is.
 * A paid link carries what was bought and whether it matches what was asked
 * for; its amount only for a browser session (null for a key or agent
 * token). Anyone else gets 404, and so does everyone once the account or
 * team is deleted (its links go with it).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Two a second at most: the SDKs poll at least a second apart.
  const rateLimited = await checkRateLimit(request, "billing-checkout-poll", 120);
  if (rateLimited) return rateLimited;

  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { id } = await params;
  const notFound = Response.json({ error: "Checkout link not found" }, { status: 404 });
  if (!UUID.test(id)) return notFound;

  try {
    const checkout = await getCheckoutLink(id, auth.userId);
    if (!checkout) return notFound;
    // What the person paid is theirs to see: a key or agent token learns
    // what was bought and whether it matches, never the amount.
    if (auth.keyId && checkout.bought) {
      return Response.json({
        checkout: { ...checkout, bought: { ...checkout.bought, amount: null } },
      });
    }
    return Response.json({ checkout });
  } catch (error) {
    reportError("GET /api/billing/checkouts/[id] failed", loggablePolarError(error));
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * DELETE /api/billing/checkouts/{id}: cancels a link the person has not
 * opened yet, so it can no longer be paid; the answer is the link, now
 * expired. Whoever may follow it (GET above) may cancel it. A link already
 * opened has a Polar checkout that cannot be ended, so it gets 409 opened
 * and expires on its own; a paid one 409 not_open; one being opened at
 * that moment 409 opening. Every attempt is audited.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rateLimited = await checkRateLimit(request, "billing-checkouts", 20);
  if (rateLimited) return rateLimited;

  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { id } = await params;
  if (!UUID.test(id)) {
    return Response.json({ error: "Checkout link not found" }, { status: 404 });
  }

  try {
    const checkout = await expireCheckoutLink(id, auth.userId);
    await auditUserAction(request, auth.userId, {
      action: "billing.checkout_link_canceled",
      status: 200,
      teamId: checkout.teamId,
      targetId: id,
    });
    return Response.json({ checkout });
  } catch (error) {
    const { response, reason } = checkoutErrorResponse(error, "Failed to cancel the checkout link");
    await auditUserAction(request, auth.userId, {
      action: "billing.checkout_link_canceled",
      status: response.status,
      reason,
      targetId: id,
    });
    return response;
  }
}
