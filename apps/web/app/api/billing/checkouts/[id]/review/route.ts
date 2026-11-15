import { authenticateSessionRequest } from "@/lib/api-auth";
import { reviewCheckoutLink } from "@/lib/billing/checkout-links";
import { networkOf } from "@/lib/device-requester";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkoutErrorResponse } from "../../shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/billing/checkouts/{id}/review: what the checkout link's page
 * (/checkout/{id}) shows before the person continues to payment: what it
 * buys and costs, the account or team that pays, who asked, when, and
 * whether from this browser's network. A browser session only, of the
 * billing account's owner (the team's owner for a team), past two-factor
 * sign-in when the account has it; an API key or agent token gets 403.
 * Makes nothing in Polar: only POST .../open does, when the person
 * continues. Another account gets 403 wrong_account; an unknown link 404.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rateLimited = await checkRateLimit(request, "billing-checkout-review", 60);
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
    const review = await reviewCheckoutLink(id, auth.userId, networkOf(request));
    return Response.json({ review });
  } catch (error) {
    return checkoutErrorResponse(error, "Failed to read the checkout link").response;
  }
}
