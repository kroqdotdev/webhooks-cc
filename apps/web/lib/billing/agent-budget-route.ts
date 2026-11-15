import { z } from "zod";
import { requestApproval } from "@/lib/approvals/request";
import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { getTeamForOwner, TeamBillingError } from "@/lib/supabase/team-billing";
import { isUuid } from "@/lib/uuid";
import {
  AGENT_BUDGET_RENEWAL_NOTE,
  emailBudgetSet,
  getAgentBudgetState,
  MAX_AGENT_BUDGET_CENTS,
  parseBudgetCents,
  setAgentBudget,
  type AgentBudget,
  type BudgetAccount,
  type BudgetSpendView,
} from "./agent-budget";

/**
 * GET and PUT of an agent spend budget, for the account itself
 * (`/api/billing/agent-budget`) or a team it owns
 * (`/api/teams/{teamId}/billing/agent-budget`), after the route has
 * authenticated the caller. Reading takes any key of the owner, or a session. Setting it in a session sets it; an API key or agent
 * token may lower it (to 0, say) at once, while a raise answers 202 with a
 * `billing.agent_budget` approval for the owner.
 */

export type { BudgetSpendView };

export interface AgentBudgetView extends AgentBudget {
  maxCents: number;
  note: string;
  spends: BudgetSpendView[];
}

/**
 * The budget and its spends, from one read at the database's clock
 * (agent_budget_state), so the list and spentCents always agree.
 */
export async function budgetView(account: BudgetAccount): Promise<AgentBudgetView | null> {
  const state = await getAgentBudgetState(account);
  if (!state) return null;
  return {
    ...state,
    maxCents: MAX_AGENT_BUDGET_CENTS,
    note: AGENT_BUDGET_RENEWAL_NOTE,
  };
}

/** Only a team's owner reads or sets its budget. */
async function ownerOnly(userId: string, teamId: string | null): Promise<Response | null> {
  if (!teamId) return null;
  if (!isUuid(teamId)) return Response.json({ error: "Team not found" }, { status: 404 });
  try {
    await getTeamForOwner(userId, teamId);
    return null;
  } catch (error) {
    if (error instanceof TeamBillingError) {
      return Response.json(
        { error: error.message },
        { status: error.code === "not_owner" ? 403 : 404 }
      );
    }
    throw error;
  }
}

/** What an authenticated caller of a budget route is. */
export interface BudgetCaller {
  userId: string;
  keyId?: string;
  agentRegistrationId?: string | null;
}

export async function readAgentBudgetResponse(
  auth: BudgetCaller,
  teamId: string | null
): Promise<Response> {
  try {
    const refused = await ownerOnly(auth.userId, teamId);
    if (refused) return refused;
    const view = await budgetView({ userId: auth.userId, teamId });
    if (!view) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(view);
  } catch (error) {
    reportError("[agent-budget] reading a budget failed", error);
    return Response.json({ error: "Failed to read the agent budget" }, { status: 500 });
  }
}

const putBody = z.object({ budgetCents: z.unknown() });

/**
 * Sets a budget for a session, or lowers it for an API key or agent token;
 * a raise asked with a key answers 202 with a billing.agent_budget approval.
 */
export async function setAgentBudgetOrAskApproval(
  request: Request,
  auth: BudgetCaller,
  teamId: string | null
): Promise<Response> {
  const rateLimited = await checkRateLimit(request, "agent-budget-set", 20);
  if (rateLimited) return rateLimited;
  const parsed = await parseJsonBodyWith(request, putBody);
  if ("error" in parsed) return parsed.error;
  const cents = parseBudgetCents(parsed.data.budgetCents);
  if (cents === null) {
    return Response.json(
      {
        error: `Give budgetCents as whole cents from 0 to ${MAX_AGENT_BUDGET_CENTS} ($${MAX_AGENT_BUDGET_CENTS / 100})`,
      },
      { status: 400 }
    );
  }

  try {
    const refused = await ownerOnly(auth.userId, teamId);
    if (refused) return refused;
    const account: BudgetAccount = { userId: auth.userId, teamId };
    const viaKey = Boolean(auth.keyId);
    const result = await setAgentBudget(account, cents, viaKey);
    if (result.status === "no_account" || result.status === "changed") {
      // "changed" only answers a call that named the budget it expected.
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (result.status === "raise_needs_owner") {
      // A raise asked with a key: the owner approves it.
      return requestApproval(
        request,
        {
          userId: auth.userId,
          keyId: auth.keyId!,
          agentRegistrationId: auth.agentRegistrationId ?? null,
        },
        "billing.agent_budget",
        {
          teamId,
          budgetCents: cents,
          keyId: auth.keyId,
          agentRegistrationId: auth.agentRegistrationId ?? null,
        }
      );
    }
    await auditUserAction(request, auth.userId, {
      action: "billing.agent_budget_set",
      status: 200,
      teamId,
      metadata: {
        previousCents: result.previousCents,
        budgetCents: result.budgetCents,
        direction: directionOf(result.previousCents, result.budgetCents),
      },
    });
    if (result.budgetCents > result.previousCents) {
      await emailBudgetSet(account, result.previousCents, result.budgetCents, "you").catch((e) =>
        reportError("[agent-budget] the budget email was not sent", e)
      );
    }
    const view = await budgetView(account);
    return Response.json({ ...view, previousCents: result.previousCents });
  } catch (error) {
    reportError("[agent-budget] setting a budget failed", error);
    return Response.json({ error: "Failed to set the agent budget" }, { status: 500 });
  }
}

export function directionOf(previous: number, next: number): "raised" | "lowered" | "unchanged" {
  return next > previous ? "raised" : next < previous ? "lowered" : "unchanged";
}
