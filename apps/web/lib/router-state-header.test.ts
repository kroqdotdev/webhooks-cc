import { describe, expect, it } from "vitest";
// Next's own validator, imported only here: if a Next upgrade moves or
// rewords it, this test fails and the patterns get checked again.
import { parseAndValidateFlightRouterState } from "next/dist/server/app-render/parse-and-validate-flight-router-state";
// And the client's writer, so a change to how it encodes the header fails here
// rather than turning every navigation into a 400.
import { prepareFlightRouterStateForRequest } from "next/dist/client/flight-data-helpers";
import {
  ROUTER_STATE_ERRORS,
  ROUTER_STATE_MAX_LENGTH,
  isRouterStateHeaderError,
  malformedRouterState,
} from "./router-state-header";

/** The header as Next's client writes it, for a navigation and for a dev HMR refresh. */
const written = (tree: unknown) =>
  [false, true].map((hmr) =>
    prepareFlightRouterStateForRequest(
      tree as Parameters<typeof prepareFlightRouterStateForRequest>[0],
      hmr
    )
  );

/** URI-encoded JSON, for values the client would never write. */
const encode = (value: unknown) => encodeURIComponent(JSON.stringify(value));

/** Next's verdict on a header: null when it accepts it, else the message it throws. */
function nextRefuses(value: string): string | null {
  try {
    parseAndValidateFlightRouterState(value);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

const CLIENT_TREES: unknown[] = [
  ["", { children: ["dashboard", { children: ["__PAGE__", {}] }] }],
  // A dynamic segment, a refresh marker and prefetch hints (Next 16).
  [
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
  ],
  // A parallel route with an interception segment, and a catch-all.
  ["", { children: ["a", {}], modal: [["id", "1", "ci(.)", ["new"]], {}] }],
  ["", { children: ["docs", { children: [["slug", "sdk/testing", "c", null], {}] }] }],
  // Non-ASCII and every character JSON or a URL treats specially.
  ["", { children: ["ünïcødé 漢字 😀", { children: [`'"\\/?#&=%+,;:@!*()~`, {}] }] }],
];

/** A random tree with random segment names, written the way the client writes it. */
function randomTree(depth: number, random: () => number): unknown {
  const name = Array.from({ length: Math.floor(random() * 6) }, () =>
    String.fromCodePoint(Math.floor(random() * 0x2fff) + 0x20)
  ).join("");
  const children: Record<string, unknown> = {};
  if (depth > 0) {
    for (let i = 0; i < Math.floor(random() * 3); i++) {
      children[i === 0 ? "children" : `slot${i}`] = randomTree(depth - 1, random);
    }
  }
  const segment = random() < 0.3 ? [name, name, "d", random() < 0.5 ? null : [name]] : name;
  return random() < 0.3 ? [segment, children, null, "refetch"] : [segment, children];
}

describe("malformedRouterState", () => {
  it("lets every tree Next's client writes through, and Next accepts them", () => {
    for (const header of CLIENT_TREES.flatMap(written)) {
      expect(malformedRouterState(header), header).toBe(false);
      expect(nextRefuses(header), header).toBeNull();
    }
  });

  it("lets random client trees through", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 2000; i++) {
      for (const header of written(randomTree(4, random))) {
        expect(malformedRouterState(header), header).toBe(false);
      }
    }
  });

  it("refuses only headers Next refuses too, with an error the reports leave out", () => {
    const one = encode(["", {}]);
    const refused = [
      "%7Bnot-json",
      "not json",
      "x",
      // A duplicated header, which reaches Next joined with a comma.
      `${one}, ${one}`,
      // A broken escape.
      "%5B%E0%A4%A",
      // An encoded object or string rather than an array.
      encode({ a: 1 }),
      encode("x"),
      // Over Next's size limit.
      `%5B${"a".repeat(ROUTER_STATE_MAX_LENGTH)}`,
    ];
    for (const value of refused) {
      expect(malformedRouterState(value), value).toBe(true);
      const message = nextRefuses(value);
      expect(message, value).not.toBeNull();
      expect(ROUTER_STATE_ERRORS.has(message!), message!).toBe(true);
    }
  });

  it("refuses raw JSON, which Next accepts but its client never writes", () => {
    const raw = JSON.stringify(["", {}]);
    expect(malformedRouterState(raw)).toBe(true);
    expect(nextRefuses(raw)).toBeNull();
  });

  it("lets well-formed headers of the wrong shape through to Next, which reports leave out", () => {
    for (const value of [encode([{}]), encode(["", {}, "x"]), encode([[], {}]), "%5B%FF"]) {
      expect(malformedRouterState(value), value).toBe(false);
      const message = nextRefuses(value);
      expect(message, value).not.toBeNull();
      expect(isRouterStateHeaderError(new Error(message!))).toBe(true);
    }
  });

  it("matches a header of the largest size quickly", () => {
    const value = `%5B${"%22a".repeat((ROUTER_STATE_MAX_LENGTH - 3) / 4)}`;
    const start = performance.now();
    expect(malformedRouterState(value)).toBe(false);
    expect(malformedRouterState(`${value}!`)).toBe(false);
    expect(malformedRouterState(`${value} `)).toBe(true);
    // Linear matching takes about a millisecond; backtracking would take
    // seconds. The bound is loose so a busy CI runner never trips it.
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("isRouterStateHeaderError", () => {
  it("matches the errors Next throws for a bad header, and nothing else", () => {
    for (const message of ROUTER_STATE_ERRORS) {
      expect(isRouterStateHeaderError(new Error(message))).toBe(true);
    }
    expect(isRouterStateHeaderError(new Error("The router state header"))).toBe(false);
    expect(isRouterStateHeaderError("The router state header was too large.")).toBe(false);
  });
});
