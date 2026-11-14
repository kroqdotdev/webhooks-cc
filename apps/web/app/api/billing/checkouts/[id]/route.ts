import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { getCheckoutLink } from "@/lib/billing/checkout-links";
import { loggablePolarError } from "@/lib/polar";
import { reportError } from "@/lib/observability";
import { checkRateLimit } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/billing/checkouts/{id}: where a checkout link stands (open, paid
 * or expired) and what it buys, for the person who asked for it, with any
 * of their keys, agents or sessions. The link itself is only in the answer
 * while it is open. Anyone else gets 404.
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
    return Response.json({ checkout });
  } catch (error) {
    reportError("GET /api/billing/checkouts/[id] failed", loggablePolarError(error));
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
