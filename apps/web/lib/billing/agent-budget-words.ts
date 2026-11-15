/**
 * How a change counts against an agent budget, in the words every place
 * that sets a budget, the API's answers and every budget email carry
 * (lib/billing/agent-budget.ts budgetCostCents and RISE_COUNTED_DAYS).
 */
export const AGENT_BUDGET_RENEWAL_NOTE =
  "Each change counts against the budget at what it charges now plus how much it raises the next renewal (on a monthly plan always; on an annual plan when the renewal is at most 31 days away), and stays counted until 30 days after that renewal, so the budget bounds both. On an annual plan whose renewal is further away, a change counts at the larger of the two (a seat at the full year's price), so the charge now and that renewal's rise together can come to more than it counted, and a seat added more than 60 days before the renewal is not bounded at that renewal at all: the budget no longer counts it when the renewal charges the new price. Renewals after that keep the new price.";

/**
 * What the agent budget panel says the budget lets agents do, by account
 * and plan (lib/billing/agent-budget.ts classifyChange): a team's buys
 * seats and Team Business, a Pro account's the move to Business, and on
 * Business, with nothing higher to move to, only reductions run on it.
 */
export function agentBudgetDescription(
  teamId: string | undefined,
  plan: string | undefined
): string {
  if (teamId) {
    return "Lets your API keys and agents add seats or move this team to Team Business without asking you each time, while what each change counts (for 30 days or more) fits in this much before tax. You get an email for every such change.";
  }
  if (plan === "business") {
    return "On Business there is no higher plan to move to, so this budget only lets your API keys and agents make reductions without asking you, such as fewer monthly blocks. Nothing is charged on it, and every other change still waits for your approval.";
  }
  return "Lets your API keys and agents move you from Pro to Business without asking you each time, while what each change counts (for 30 days or more) fits in this much before tax. You get an email for every such change.";
}
