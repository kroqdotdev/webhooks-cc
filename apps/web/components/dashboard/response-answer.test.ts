import { describe, expect, it } from "vitest";
import { answerLabel } from "./response-answer";

describe("answerLabel", () => {
  it("names the status and the rule that chose it", () => {
    expect(answerLabel({ responseStatus: 402, responseRule: "Payment failed" })).toBe(
      "Answered 402 (Rule: Payment failed)"
    );
    // An unnamed rule is stored by its place, as the dashboard numbers rules.
    expect(answerLabel({ responseStatus: 409, responseRule: "Rule 2" })).toBe(
      "Answered 409 (Rule 2)"
    );
  });

  it("names only the status when no rule chose it", () => {
    expect(answerLabel({ responseStatus: 200, responseRule: null })).toBe("Answered 200");
  });

  it("says nothing for requests with no record (emails, older captures)", () => {
    expect(answerLabel({})).toBeNull();
    expect(answerLabel({ responseStatus: null, responseRule: "Payment failed" })).toBeNull();
  });
});
