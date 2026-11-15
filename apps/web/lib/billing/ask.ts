import { requestApproval } from "@/lib/approvals/request";
import { reportError } from "@/lib/observability";
import { loggablePolarError } from "@/lib/polar";
import { checkRateLimit } from "@/lib/rate-limit";
import { trySpendFromBudget, type BudgetAttempt } from "./agent-budget";
import type { BillingChange } from "./change";

/** An authenticated caller of a billing route: a session, or an API key or agent token. */
export interface BillingCaller {
  userId: string;
  keyId?: string;
  agentRegistrationId?: string | null;
}

/**
 * The answer a billing route gives an API key or agent token: the change
 * made on the account's agent budget (200) when the budget may pay for it
 * (lib/billing/agent-budget.ts), else a quoted `billing.change` approval
 * (202) for the account's owner, with `budget` saying why the budget did
 * not pay when it was a change it could have. Null for a session, which
 * makes the change at once.
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
  let attempt: BudgetAttempt;
  try {
    attempt = await trySpendFromBudget(request, caller, teamId, change);
  } catch (error) {
    // trySpendFromBudget answers every failure after a take itself
    // (outcome_unknown), so nothing was taken: the approval path, which
    // needs no budget, answers the change.
    reportError("[agent-budget] a billing change on the budget failed", loggablePolarError(error));
    attempt = { kind: "none" };
  }
  if (attempt.kind === "done") return attempt.response;
  const asked = await requestApproval(
    request,
    {
      userId: caller.userId,
      keyId: caller.keyId,
      agentRegistrationId: caller.agentRegistrationId ?? null,
    },
    "billing.change",
    { teamId, change }
  );
  if (attempt.kind !== "fallback" || asked.status !== 202) return asked;
  const body = (await asked.json()) as Record<string, unknown>;
  return Response.json({ ...body, budget: attempt.budget }, { status: 202 });
}
