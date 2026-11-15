import { describe, expect, it } from "vitest";
import { supersededExplanation } from "./superseded-copy";

describe("supersededExplanation", () => {
  it("never promises a refund, and says what happened for each purchase", () => {
    const texts = [
      supersededExplanation("plan", null),
      supersededExplanation("team_plan", null),
      supersededExplanation("monthly_blocks", "requests"),
      supersededExplanation("monthly_blocks", "domains"),
      supersededExplanation("overage", "requests"),
      supersededExplanation(null, null),
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/goes back|back to your card|refunded/i);
    }
    expect(supersededExplanation("plan", null)).toContain(
      "refund of what it charged is under review"
    );
    expect(supersededExplanation("monthly_blocks", "pages")).toContain("one-time blocks");
    expect(supersededExplanation("monthly_blocks", "domains")).toContain("under review");
    expect(supersededExplanation("overage", "pages")).toContain("nothing was or will be charged");
  });

  it("never says a subscription ended for monthly blocks or an unknown kind", () => {
    // A top-up of monthly blocks is an order: no subscription ended for it.
    for (const resource of ["requests", "pages", "domains"]) {
      expect(supersededExplanation("monthly_blocks", resource)).not.toMatch(
        /subscription was ended/i
      );
    }
    expect(supersededExplanation(undefined, undefined)).not.toMatch(/subscription was ended/i);
  });
});
