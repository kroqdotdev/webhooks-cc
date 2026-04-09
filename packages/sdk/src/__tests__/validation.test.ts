import { describe, it, expect } from "vitest";
import { validateMockResponse, validateResponseRules } from "../validation";
import type { ResponseRule, MockResponse } from "../types";

const validResponse: MockResponse = {
  status: 200,
  body: "ok",
  headers: {},
};

function makeRule(overrides: Partial<ResponseRule> = {}): ResponseRule {
  return {
    conditions: [{ field: "method", op: "eq", value: "POST" }],
    response: validResponse,
    ...overrides,
  };
}

describe("validateResponseRules", () => {
  it("accepts a valid rules array", () => {
    expect(() => validateResponseRules([makeRule()])).not.toThrow();
  });

  it("accepts an empty array", () => {
    expect(() => validateResponseRules([])).not.toThrow();
  });

  it("accepts rules with all condition types", () => {
    const rules: ResponseRule[] = [
      makeRule({
        conditions: [
          { field: "method", op: "eq", value: "POST" },
          { field: "path", op: "contains", value: "/stripe" },
          { field: "header", op: "exists", name: "stripe-signature" },
          { field: "body_contains", op: "contains", value: "invoice" },
          { field: "body_path", op: "eq", path: "type", value: "invoice.paid" },
          { field: "query", op: "eq", name: "source", value: "test" },
        ],
      }),
    ];
    expect(() => validateResponseRules(rules)).not.toThrow();
  });

  it("accepts rules with OR logic", () => {
    expect(() => validateResponseRules([makeRule({ logic: "or" })])).not.toThrow();
  });

  it("rejects non-array", () => {
    expect(() => validateResponseRules("not an array" as unknown as ResponseRule[])).toThrow(
      "must be an array"
    );
  });

  it("rejects more than 50 rules", () => {
    const rules = Array.from({ length: 51 }, () => makeRule());
    expect(() => validateResponseRules(rules)).toThrow("max 50");
  });

  it("rejects rule with empty conditions", () => {
    expect(() => validateResponseRules([makeRule({ conditions: [] })])).toThrow("non-empty array");
  });

  it("rejects rule with more than 10 conditions", () => {
    const conditions = Array.from({ length: 11 }, () => ({
      field: "method" as const,
      op: "eq" as const,
      value: "POST",
    }));
    expect(() => validateResponseRules([makeRule({ conditions })])).toThrow("max 10");
  });

  it("rejects invalid condition field", () => {
    expect(() =>
      validateResponseRules([
        makeRule({
          conditions: [{ field: "invalid" as never, op: "eq", value: "x" }],
        }),
      ])
    ).toThrow('invalid field "invalid"');
  });

  it("rejects invalid condition op", () => {
    expect(() =>
      validateResponseRules([
        makeRule({
          conditions: [{ field: "method", op: "regex" as never, value: ".*" }],
        }),
      ])
    ).toThrow('invalid op "regex"');
  });

  it("rejects invalid op for field (method + contains)", () => {
    expect(() =>
      validateResponseRules([
        makeRule({
          conditions: [{ field: "method", op: "contains", value: "POST" }],
        }),
      ])
    ).toThrow('op "contains" is not valid for field "method"');
  });

  it("rejects invalid op for field (query + matches)", () => {
    expect(() =>
      validateResponseRules([
        makeRule({
          conditions: [{ field: "query", op: "matches" as never, name: "q", value: "*" }],
        }),
      ])
    ).toThrow('op "matches" is not valid for field "query"');
  });

  it("rejects invalid logic value", () => {
    expect(() => validateResponseRules([makeRule({ logic: "xor" as never })])).toThrow("logic");
  });

  it("rejects invalid response status", () => {
    expect(() =>
      validateResponseRules([
        makeRule({
          response: { status: 999, body: "", headers: {} },
        }),
      ])
    ).toThrow("status");
  });

  it("rejects invalid response delay", () => {
    expect(() =>
      validateResponseRules([
        makeRule({
          response: { status: 200, body: "", headers: {}, delay: 99999 },
        }),
      ])
    ).toThrow("delay");
  });
});

describe("validateMockResponse", () => {
  it("accepts a valid mock response", () => {
    expect(() => validateMockResponse(validResponse)).not.toThrow();
  });

  it("accepts a mock response with delay", () => {
    expect(() => validateMockResponse({ ...validResponse, delay: 1000 })).not.toThrow();
  });

  it("rejects status below minimum", () => {
    expect(() => validateMockResponse({ ...validResponse, status: 50 })).toThrow("status");
  });

  it("rejects status above maximum", () => {
    expect(() => validateMockResponse({ ...validResponse, status: 600 })).toThrow("status");
  });

  it("rejects delay above maximum", () => {
    expect(() => validateMockResponse({ ...validResponse, delay: 60000 })).toThrow("delay");
  });
});
