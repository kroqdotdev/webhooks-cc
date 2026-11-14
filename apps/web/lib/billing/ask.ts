import { requestApproval } from "@/lib/approvals/request";
import { checkRateLimit } from "@/lib/rate-limit";
import type { BillingChange } from "./change";

/** An authenticated caller of a billing route: a session, or an API key or agent token. */
export interface BillingCaller {
  userId: string;
  keyId?: string;
  agentRegistrationId?: string | null;
}

/**
 * The answer a billing route gives an API key or agent token: a quoted
 * `billing.change` approval (202) for the account's owner, never the change
 * itself. Null for a session, which makes the change at once.
 */
export async function askForBillingChange(
  request: Request,
  caller: BillingCaller,
  teamId: string | null,
  change: BillingChange
): Promise<Response | null> {
  if (!caller.keyId) return null;
  // Each ask reads Polar to quote it, like the quote routes.
  const rateLimited = await checkRateLimit(request, "billing-change-ask", 20);
  if (rateLimited) return rateLimited;
  return requestApproval(
    request,
    {
      userId: caller.userId,
      keyId: caller.keyId,
      agentRegistrationId: caller.agentRegistrationId ?? null,
    },
    "billing.change",
    { teamId, change }
  );
}
