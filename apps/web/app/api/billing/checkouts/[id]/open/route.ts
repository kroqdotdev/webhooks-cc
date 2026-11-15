import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { openCheckoutLink } from "@/lib/billing/checkout-links";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkoutErrorResponse } from "../../shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/billing/checkouts/{id}/open: the checkout link's page
 * (/checkout/{id}) opening it for the person. A browser session only, of
 * the billing account's owner (the team's owner for a team), past
 * two-factor sign-in when the account has it (authenticateSessionRequest);
 * an API key or agent token gets 403, so Polar's checkout never reaches a
 * key holder. The purchase is checked again and a Polar checkout made (or
 * the link's own reused while Polar has it open): the answer is
 * { status: "redirect", url } for the page to go on to, or the link's state
 * (paid, processing, expired, superseded) with what it buys: its summary,
 * kind and resource (and an expired link's expiredReason) (what a superseded link's explanation is worded by,
 * when the page has no review to go on). Another
 * account gets 403 wrong_account; an unknown link 404. Opening is audited.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rateLimited = await checkRateLimit(request, "billing-checkout-open", 20);
  if (rateLimited) return rateLimited;

  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { id } = await params;
  if (!UUID.test(id)) {
    return Response.json(
      { error: "This checkout link does not exist.", code: "not_found" },
      { status: 404 }
    );
  }

  try {
    const opened = await openCheckoutLink(id, auth.userId);
    if (opened.kind === "redirect") {
      await auditUserAction(request, auth.userId, {
        action: "billing.checkout_link_opened",
        status: 200,
        targetId: id,
      });
      return Response.json({
        status: "redirect",
        url: opened.url,
        summary: opened.summary,
        kind: opened.link.kind,
        resource: opened.link.resource,
      });
    }
    return Response.json({
      status: opened.kind,
      summary: opened.summary,
      kind: opened.link.kind,
      resource: opened.link.resource,
      // "unsettled": expired while Polar never said it was not paid.
      ...(opened.kind === "expired" ? { expiredReason: opened.expiredReason } : {}),
    });
  } catch (error) {
    const { response, reason } = checkoutErrorResponse(error, "Failed to open the checkout");
    await auditUserAction(request, auth.userId, {
      action: "billing.checkout_link_opened",
      status: response.status,
      reason,
      targetId: id,
    });
    return response;
  }
}
