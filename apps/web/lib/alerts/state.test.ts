import { describe, expect, it } from "vitest";
import {
  fieldAlertDue,
  missingFields,
  missShare,
  nextFieldState,
  requiredFieldNames,
  layoutMissing,
  NO_LAYOUT,
  PARSE_FAILED,
} from "./state";

describe("field alert state", () => {
  it("counts misses in a row and keeps the last 20 outcomes", () => {
    let state = nextFieldState({ streak: 0, recent: "" }, [true, false, false]);
    expect(state).toEqual({ streak: 2, recent: "100" });
    state = nextFieldState(state, [true]);
    expect(state).toEqual({ streak: 0, recent: "1001" });
    state = nextFieldState(state, Array(30).fill(false));
    expect(state.recent).toBe("0".repeat(20));
    expect(state.streak).toBe(30);
  });

  it("needs five outcomes before the share rule speaks", () => {
    expect(missShare("00")).toBeNull();
    expect(missShare("10100")).toBe(60);
  });

  it("opens on either rule", () => {
    const rules = { fieldFailures: 3, fieldFailureShare: 50 };
    expect(fieldAlertDue(rules, { streak: 3, recent: "000" })).toBe(true);
    expect(fieldAlertDue(rules, { streak: 1, recent: "10100" })).toBe(true);
    expect(fieldAlertDue(rules, { streak: 1, recent: "11110" })).toBe(false);
    expect(
      fieldAlertDue({ fieldFailures: null, fieldFailureShare: null }, { streak: 9, recent: "0" })
    ).toBe(false);
  });

  it("checks only fields the endpoint has", () => {
    expect(requiredFieldNames(["a", "b"], null)).toEqual(["a", "b"]);
    expect(requiredFieldNames(["a", "b"], ["b", "gone"])).toEqual(["b"]);
    expect(missingFields({ a: "1", b: null }, ["a", "b"])).toEqual(["b"]);
    expect(missingFields(null, ["a"])).toEqual(["a"]);
  });
});

describe("layout misses", () => {
  const parsed = (fields: Record<string, string | null>) => ({
    status: "matched" as const,
    layout: { id: "orders", name: "Orders" },
    fields,
    lineItems: [],
    lineItemColumns: [],
    attachments: [],
    pages: 0,
  });

  it("counts no layout and a failed parse as misses, and waits for a pending parse", () => {
    expect(
      layoutMissing({ ...parsed({}), status: "no_layout", layout: null }, {}, [], null)
    ).toEqual([NO_LAYOUT]);
    expect(layoutMissing("failed", {}, [], null)).toEqual([PARSE_FAILED]);
    expect(layoutMissing("pending", {}, [], null)).toEqual([]);
    expect(layoutMissing("none", {}, [], null)).toEqual([]);
  });

  it("checks the layout's fields and the endpoint's, every one unless some are named", () => {
    const parse = parsed({ order: "1001", total: null });
    expect(layoutMissing(parse, { ref: "x" }, ["ref"], null)).toEqual(["total"]);
    expect(layoutMissing(parse, { ref: null }, ["ref"], ["order"])).toEqual([]);
    expect(layoutMissing(parse, { ref: null }, ["ref"], ["ref", "order"])).toEqual(["ref"]);
  });
});
