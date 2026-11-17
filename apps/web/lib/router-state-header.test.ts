import { describe, expect, it } from "vitest";
import {
  ROUTER_STATE_MAX_LENGTH,
  isRouterStateHeaderError,
  malformedRouterState,
} from "./router-state-header";

/** The header as Next's client writes it (prepareFlightRouterStateForRequest). */
const encode = (tree: unknown) => encodeURIComponent(JSON.stringify(tree));

describe("malformedRouterState", () => {
  it("lets a missing header through", () => {
    expect(malformedRouterState(null)).toBe(false);
  });

  it("lets the trees Next's client sends through", () => {
    // /dashboard
    expect(
      malformedRouterState(
        encode(["", { children: ["dashboard", { children: ["__PAGE__", {}] }] }])
      )
    ).toBe(false);
    // A dynamic segment, a refresh marker and prefetch hints (Next 16).
    const tree = [
      "",
      {
        children: [
          "endpoints",
          {
            children: [
              ["slug", "abc123", "d", null],
              { children: ["__PAGE__", {}, null, "refetch", 0] },
              null,
              "refetch",
            ],
          },
        ],
      },
      null,
      null,
      1,
    ];
    expect(malformedRouterState(encode(tree))).toBe(false);
    // Parallel routes and an interception segment.
    expect(
      malformedRouterState(
        encode(["", { children: ["a", {}], modal: [["id", "1", "ci(.)", ["new"]], {}] }])
      )
    ).toBe(false);
  });

  it("refuses a header that is no URI-encoded JSON", () => {
    expect(malformedRouterState("%E0%A4%A")).toBe(true);
    expect(malformedRouterState("not json")).toBe(true);
    expect(malformedRouterState("")).toBe(true);
  });

  it("refuses JSON that is no route tree", () => {
    for (const value of [
      null,
      1,
      "x",
      {},
      [],
      [""],
      ["", null],
      ["", []],
      [1, {}],
      ["", { children: "x" }],
      ["", { children: ["a", { c: [] }] }],
    ]) {
      expect(malformedRouterState(encode(value))).toBe(true);
    }
  });

  it("refuses a duplicated header, which arrives joined with a comma", () => {
    const one = encode(["", {}]);
    expect(malformedRouterState(`${one}, ${one}`)).toBe(true);
  });

  it("refuses a header over Next's size limit", () => {
    const padded = encode(["", {}]) + " ".repeat(ROUTER_STATE_MAX_LENGTH);
    expect(malformedRouterState(padded)).toBe(true);
  });
});

describe("isRouterStateHeaderError", () => {
  it("matches the errors Next throws for a bad header, and nothing else", () => {
    expect(
      isRouterStateHeaderError(
        new Error("The router state header was sent but could not be parsed.")
      )
    ).toBe(true);
    expect(
      isRouterStateHeaderError(
        new Error("Multiple router state headers were sent. This is not allowed.")
      )
    ).toBe(true);
    expect(isRouterStateHeaderError(new Error("The router state header was too large."))).toBe(
      true
    );
    expect(isRouterStateHeaderError(new Error("The router state header"))).toBe(false);
    expect(isRouterStateHeaderError("The router state header was too large.")).toBe(false);
  });
});
