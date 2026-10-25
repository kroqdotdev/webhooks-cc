import { describe, expect, it } from "vitest";
import {
  emailFieldValues,
  emailFieldsProblems,
  normalizedEmailFields,
  re2Find,
} from "./email-fields";

describe("re2Find", () => {
  it("returns the first group, or the whole match without one", () => {
    expect(re2Find("Invoice (INV-\\d+)", "Invoice INV-2041 for October")).toBe("INV-2041");
    expect(re2Find("INV-\\d+", "Invoice INV-2041")).toBe("INV-2041");
    expect(re2Find("PO-(\\d+)", "Invoice INV-2041")).toBeNull();
    expect(re2Find("(?i)total: ([\\d.]+)", "TOTAL: 42.00")).toBe("42.00");
  });

  it("never matches a pattern RE2 refuses, and the problems say why", () => {
    expect(re2Find("(?<=x)y", "xy")).toBeNull();
    expect(emailFieldsProblems([{ name: "a", from: "text", pattern: "(?<=x)y" }])).toEqual([
      expect.stringMatching(/^field 1: pattern: /),
    ]);
    expect(emailFieldsProblems([{ name: "a", from: "text", pattern: "a+b" }])).toEqual([]);
  });

  it("takes linear time on a pattern that backtracks in JavaScript", () => {
    const started = performance.now();
    expect(re2Find("(a+)+$", `${"a".repeat(50_000)}!`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("bounds", () => {
  it("refuses a pattern that compiles too large, alone or with the others", () => {
    expect(emailFieldsProblems([{ name: "a", from: "text", pattern: "([ab]{250})c" }])).toEqual([
      expect.stringMatching(/^field 1: pattern: too large to run quickly/),
    ]);
    expect(re2Find("([ab]{250})c", `${"ab".repeat(200)}c`)).toBeNull();
    const four = Array.from({ length: 4 }, (_, i) => ({
      name: `f${i}`,
      from: "text" as const,
      pattern: "([ab]{180})c",
    }));
    expect(emailFieldsProblems(four)).toEqual([
      expect.stringMatching(/^the patterns together compile to \d+ steps/),
    ]);
  });

  it("stores only a field's own keys", () => {
    expect(
      normalizedEmailFields([
        { name: "a", from: "subject", pattern: "x", header: "X", extra: "y" } as never,
        { name: "b", from: "header", header: "X-Mailer", pattern: ".+" },
      ])
    ).toEqual([
      { name: "a", from: "subject", pattern: "x" },
      { name: "b", from: "header", header: "X-Mailer", pattern: ".+" },
    ]);
  });

  it("finds a field once per email and field list", () => {
    const email = {
      id: "r1",
      kind: "email" as const,
      headers: {},
      email: {
        subject: "Invoice INV-7",
        from: [],
        to: [],
        cc: [],
        text: null,
        html: null,
      },
    } as never;
    const fields = [{ name: "invoice", from: "subject" as const, pattern: "(INV-\\d+)" }];
    expect(emailFieldValues(email, fields)).toEqual({ invoice: "INV-7" });
    const again = emailFieldValues(email, fields)!;
    again.invoice = "changed";
    expect(emailFieldValues(email, fields)).toEqual({ invoice: "INV-7" });
  });
});
