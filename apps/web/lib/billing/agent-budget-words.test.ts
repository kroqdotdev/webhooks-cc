import { describe, expect, it } from "vitest";
import { AGENT_BUDGET_RENEWAL_NOTE, agentBudgetDescription } from "./agent-budget-words";

describe("AGENT_BUDGET_RENEWAL_NOTE", () => {
  it("says plainly that annual seats added long before the renewal are not bounded there", () => {
    expect(AGENT_BUDGET_RENEWAL_NOTE).toContain("on a monthly plan always");
    expect(AGENT_BUDGET_RENEWAL_NOTE).toContain(
      "a seat added more than 60 days before the renewal is not bounded at that renewal at all"
    );
  });
});

describe("agentBudgetDescription", () => {
  it("says plainly that on Business the budget only lets agents make reductions", () => {
    const words = agentBudgetDescription(undefined, "business");
    expect(words).toContain("only lets your API keys and agents make reductions");
    expect(words).toContain("Nothing is charged on it");
    expect(words).not.toContain("move you from Pro to Business");
  });

  it("names the move to Business on Pro, and seats and Team Business for a team", () => {
    expect(agentBudgetDescription(undefined, "pro")).toContain("from Pro to Business");
    const team = agentBudgetDescription("team-id", "business");
    expect(team).toContain("add seats");
    expect(team).toContain("Team Business");
  });
});
