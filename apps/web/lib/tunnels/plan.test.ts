import { describe, expect, it } from "vitest";
import { chooseTunnelPlan } from "./plan";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe("chooseTunnelPlan", () => {
  it("takes the best of the account's own plan and its live teams", () => {
    const plan = chooseTunnelPlan(
      [
        { key: "pro", teamId: null, paidSince: daysAgo(100) },
        { key: "team_business", teamId: "t1", paidSince: daysAgo(100) },
      ],
      false,
      ["t1"],
      NOW
    );
    expect(plan.key).toBe("team_business");
    expect(plan.teamId).toBe("t1");
    expect(plan.limits.shareSlots).toBe(10);
    expect(plan.notice).toBe(false);
  });

  it("keeps the own plan when a team gives no more", () => {
    const plan = chooseTunnelPlan(
      [
        { key: "business", teamId: null, paidSince: daysAgo(100) },
        { key: "team", teamId: "t1", paidSince: daysAgo(100) },
      ],
      false,
      ["t1"],
      NOW
    );
    expect(plan.key).toBe("business");
    expect(plan.teamId).toBeNull();
  });

  it("always shows the notice on Free", () => {
    expect(
      chooseTunnelPlan([{ key: "free", teamId: null, paidSince: null }], true, [], NOW).notice
    ).toBe(true);
  });

  it("shows the notice for 7 days after an account first paid, unless lifted", () => {
    const fresh = [{ key: "pro" as const, teamId: null, paidSince: daysAgo(2) }];
    expect(chooseTunnelPlan(fresh, false, [], NOW).notice).toBe(true);
    expect(chooseTunnelPlan(fresh, true, [], NOW).notice).toBe(false);
    const settled = [{ key: "pro" as const, teamId: null, paidSince: daysAgo(8) }];
    expect(chooseTunnelPlan(settled, false, [], NOW).notice).toBe(false);
    const unknown = [{ key: "pro" as const, teamId: null, paidSince: null }];
    expect(chooseTunnelPlan(unknown, false, [], NOW).notice).toBe(true);
  });

  it("follows the team's first payment when the team's plan wins", () => {
    const plan = chooseTunnelPlan(
      [
        { key: "free", teamId: null, paidSince: null },
        { key: "team", teamId: "t1", paidSince: daysAgo(1) },
      ],
      false,
      ["t1"],
      NOW
    );
    expect(plan.key).toBe("team");
    expect(plan.notice).toBe(true);
  });
});
