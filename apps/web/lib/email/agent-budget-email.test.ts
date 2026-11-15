import { describe, expect, it } from "vitest";
import {
  buildAgentBudgetDecreaseEmail,
  buildAgentBudgetSetEmail,
  buildAgentBudgetSpentEmail,
  buildAgentBudgetUnknownEmail,
} from "./agent-budget-email";

describe("buildAgentBudgetSpentEmail", () => {
  const mail = buildAgentBudgetSpentEmail({
    to: "owner@example.com",
    change: 'Change the team "Acme <b>" from 3 to 5 seats.',
    chargedCents: 1250,
    approximate: false,
    renewalCents: 6000,
    renewalRiseCents: 2400,
    countedCents: 2400,
    key: 'the API key "deploy bot" (whcc_abc1234...)',
    leftCents: 3750,
    budgetCents: 5000,
    teamName: "Acme <b>",
    billingUrl: "https://mailhooks.cc/teams/t1",
  });

  it("names the change, the amount, the key, what is left and the new renewal", () => {
    expect(mail.kind).toBe("agent_budget_spent");
    expect(mail.text).toContain("from 3 to 5 seats");
    expect(mail.text).toContain("$12.50 before tax");
    expect(mail.text).toContain("deploy bot");
    expect(mail.text).toContain("$37.50 of $50.00");
    expect(mail.text).toContain("renews at $60.00, $24.00 more than before");
    expect(mail.text).toContain("Counted against the agent budget: $24.00");
    expect(mail.text).toContain("the charge now plus the rise of the next renewal");
  });

  it("says the larger of the two only when the spend counted that way", () => {
    const base = {
      to: "owner@example.com",
      change: "Change the team from 3 to 5 seats.",
      chargedCents: 6000,
      approximate: false,
      renewalCents: 48_000,
      renewalRiseCents: 12_000,
      countedCents: 18_000,
      key: "an API key",
      leftCents: 0,
      budgetCents: 20_000,
      teamName: null,
      billingUrl: "https://webhooks.cc/teams/t1",
    };
    // An annual plan renewing within 30 days counts both.
    const near = buildAgentBudgetSpentEmail({ ...base, annual: true, riseCounted: true });
    expect(near.text).toContain("the charge now plus the rise of the next renewal");
    const far = buildAgentBudgetSpentEmail({ ...base, annual: true, riseCounted: false });
    expect(far.text).toContain("the larger of the charge now and the rise of the next renewal");
    // Older rows carry no riseCounted: the interval decides.
    const old = buildAgentBudgetSpentEmail({ ...base, annual: true });
    expect(old.text).toContain("the larger of the charge now");
  });

  it("links only to the billing page on the owner's site and escapes names", () => {
    expect(mail.text).toContain("https://mailhooks.cc/teams/t1");
    expect(mail.html).not.toContain("<b>");
    expect(mail.html).toContain("&lt;b&gt;");
    expect(mail.html!.match(/href=/g)).toHaveLength(1);
  });
});

describe("buildAgentBudgetSetEmail", () => {
  it("says what the budget allows and that renewals rise too", () => {
    const mail = buildAgentBudgetSetEmail({
      to: "owner@example.com",
      previousCents: 0,
      budgetCents: 10_000,
      teamName: null,
      by: "you",
      billingUrl: "https://webhooks.cc/account/plan",
    });
    expect(mail.kind).toBe("agent_budget_set");
    expect(mail.subject).toContain("$100.00");
    expect(mail.text).toContain("(it was off)");
    expect(mail.text).toContain("plus how much it raises the next renewal");
    expect(mail.text).toContain("stays counted until 30 days after that renewal");
    expect(mail.text).toContain("https://webhooks.cc/account/plan");
  });

  it("names a raise from one amount to another", () => {
    const mail = buildAgentBudgetSetEmail({
      to: "owner@example.com",
      previousCents: 5000,
      budgetCents: 7500,
      teamName: "Acme",
      by: "your approval",
      billingUrl: "https://webhooks.cc/teams/t1",
    });
    expect(mail.text).toContain('team "Acme"');
    expect(mail.text).toContain("from $50.00 to $75.00");
  });
});

describe("buildAgentBudgetUnknownEmail", () => {
  it("says the card may have been charged, and that it stays counted", () => {
    const mail = buildAgentBudgetUnknownEmail({
      to: "owner@example.com",
      change: "Change the team from 3 to 5 seats.",
      chargedCents: 1600,
      approximate: false,
      renewalCents: 6000,
      renewalRiseCents: 2400,
      countedCents: 2400,
      key: 'the API key "deploy bot" (whcc_abc1234...)',
      leftCents: 7600,
      budgetCents: 10_000,
      teamName: null,
      billingUrl: "https://webhooks.cc/account/plan",
    });
    expect(mail.kind).toBe("agent_budget_unknown");
    expect(mail.subject).toContain("may have charged $16.00");
    expect(mail.text).toContain("may have been charged");
    expect(mail.text).toContain("stays counted");
    expect(mail.html!.match(/href=/g)).toHaveLength(1);
  });
});

describe("buildAgentBudgetDecreaseEmail", () => {
  it("names the reduction and who asked, with nothing charged", () => {
    const mail = buildAgentBudgetDecreaseEmail({
      to: "owner@example.com",
      reductions: [
        {
          change: "Change the team from 4 to 3 seats.",
          renewalCents: 3600,
          key: 'the agent "Claude Code"',
          madeAt: "2026-11-15T10:20:30.000Z",
        },
      ],
      teamName: "Acme <i>",
      billingUrl: "https://webhooks.cc/teams/t1",
    });
    expect(mail.kind).toBe("agent_budget_decrease");
    expect(mail.subject).toBe("An agent made a billing reduction on webhooks.cc");
    expect(mail.text).toContain("from 4 to 3 seats");
    expect(mail.text).toContain("Nothing was charged");
    expect(mail.text).toContain("Claude Code");
    expect(mail.text).toContain("2026-11-15 10:20 UTC");
    expect(mail.html).not.toContain("<i>");
  });

  it("lists every reduction since the last notice in one email", () => {
    const mail = buildAgentBudgetDecreaseEmail({
      to: "owner@example.com",
      reductions: [
        { change: "Fewer seats: 5 to 4.", renewalCents: 4800, key: "a", madeAt: "" },
        { change: "Fewer seats: 4 to 3.", renewalCents: 3600, key: "b", madeAt: "" },
      ],
      teamName: null,
      billingUrl: "https://webhooks.cc/account/plan",
    });
    expect(mail.subject).toContain("2 billing reductions");
    expect(mail.text).toContain("5 to 4");
    expect(mail.text).toContain("4 to 3");
    expect(mail.text).toContain("one email an hour at most");
    expect(mail.text).toContain("Undo them");
    expect(mail.html!.match(/<ul>/g)).toHaveLength(2);
  });
});
