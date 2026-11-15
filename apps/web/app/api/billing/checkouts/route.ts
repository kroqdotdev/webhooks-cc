import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import {
  CHECKOUT_ATTEMPTS_PER_HOUR,
  createCheckoutLink,
  itemTeamId,
  parseCheckoutItem,
} from "@/lib/billing/checkout-links";
import { checkRateLimit, checkRateLimitByKey } from "@/lib/rate-limit";
import { deviceRequester } from "@/lib/device-requester";
import { checkoutErrorResponse } from "./shared";

/**
 * POST /api/billing/checkouts: a checkout link for something the account
 * (or a team the caller owns) can buy, for an agent to hand to the person.
 * Any key of the account, a claimed agent token, or a session; a pre-claim
 * agent token is refused. No approval: nothing is charged until the person
 * pays on Polar's page with their own card. The purchase is checked now and
 * the link stored, but no Polar checkout is made: the link is our page,
 * /checkout/{id}, which the account's owner (the team's owner for a team)
 * opens signed in, and which makes the Polar checkout then. The body names
 * what to buy (lib/billing/checkout-links.ts); the answer is 201 { checkout }
 * with its url, and GET /api/billing/checkouts/{id} follows it. Every attempt
 * is audited. Limits: 20 a minute per address, 30 attempts an hour per
 * asking person, and the links' own 5 an hour and 3 open per account.
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

  // Attempts per asking person, refused and failed ones included (the
  // migration's 5 links an hour count only links that were made). Keyed on
  // the asker, never the team named in the body: a member's refused
  // attempts must not use up the owner's budget.
  const attemptsLimited = await checkRateLimitByKey(
    `billing-checkouts:user:${auth.userId}`,
    CHECKOUT_ATTEMPTS_PER_HOUR,
    60 * 60_000
  );
  if (attemptsLimited) return attemptsLimited;

  try {
    // Where the asker is, so the page can warn when the person opens the
    // link from another network.
    const { network, country } = deviceRequester(request, {});
    const checkout = await createCheckoutLink(
      {
        userId: auth.userId,
        keyId: auth.keyId,
        agentRegistrationId: auth.agentRegistrationId,
        network,
        country,
      },
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
    const { response, reason } = checkoutErrorResponse(error, "Failed to make the checkout link");
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
