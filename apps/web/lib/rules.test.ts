import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ConditionGroup, RuleSubject } from "@webhooks-cc/sdk";
import { conditionProblems, conditionsHold, re2Tester, regexProblem } from "./rules";

interface Vectors {
  requests: Record<string, Omit<RuleSubject, "kind">>;
  vectors: { name: string; request: string; group: ConditionGroup; expected: boolean }[];
}

const vectors = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/sdk/conformance/rules.json"), "utf8")
) as Vectors;

describe("conditions with RE2", () => {
  it("agree with the shared vectors (the receiver runs them too)", () => {
    expect(vectors.vectors.length).toBeGreaterThan(50);
    for (const vector of vectors.vectors) {
      const subject = { ...vectors.requests[vector.request], kind: "http" } as RuleSubject;
      expect(conditionsHold(vector.group, subject), vector.name).toBe(vector.expected);
    }
  });

  it("runs patterns in linear time", () => {
    // Catastrophic for a backtracking engine: (a+)+$ against a's followed by b.
    const started = performance.now();
    expect(re2Tester("(a+)+$", `${"a".repeat(5000)}b`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("explains a pattern RE2 cannot compile", () => {
    expect(regexProblem("(")).toMatch(/missing closing \)/);
    expect(regexProblem("(?<=a)b")).not.toBeNull();
    expect(regexProblem("^order\\.")).toBeNull();
    expect(regexProblem("a".repeat(501))).toMatch(/longer than 500/);
  });

  it("reports regex problems with the condition's position", () => {
    expect(
      conditionProblems([{ field: "path", op: "regex", value: "(" }], "response", "rules[0]")
    ).toEqual([expect.stringMatching(/^rules\[0\]\[0\]: regex: /)]);
  });

  it("keeps filter-only fields out of response rules", () => {
    expect(
      conditionProblems([{ field: "signature", op: "eq", value: "verified" }], "response")
    ).toHaveLength(1);
    expect(
      conditionProblems([{ field: "signature", op: "eq", value: "verified" }], "filter")
    ).toEqual([]);
  });
});
