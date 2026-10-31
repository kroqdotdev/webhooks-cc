import { describe, expect, it } from "vitest";
import type { Layout } from "@webhooks-cc/sdk/email";
import type { RequestRecord } from "@/lib/supabase/requests";
import {
  attachmentMatcher,
  chooseLayout,
  layoutsProblems,
  lineItemsFromSheets,
  lineItemsFromText,
} from "./layouts";

function email(subject: string, text: string): RequestRecord {
  return {
    id: "r1",
    endpointId: "e1",
    method: "EMAIL",
    path: "acme@mailhooks.cc",
    headers: { subject },
    queryParams: {},
    ip: "192.0.2.1",
    size: 1,
    receivedAt: 0,
    kind: "email",
    email: {
      subject,
      text,
      html: null,
      from: [{ name: null, address: "orders@acme.example" }],
      to: [],
      cc: [],
      replyTo: [],
      sender: [],
      date: null,
      messageId: null,
      inReplyTo: [],
      tag: null,
      textFromHtml: false,
      attachments: [],
      auth: null,
      smtp: null,
      parseError: false,
      truncated: {},
    },
  } as unknown as RequestRecord;
}

const orders: Layout = {
  id: "orders",
  name: "Orders",
  match: { conditions: [{ field: "email", name: "subject", op: "contains", value: "Order" }] },
};
const fallback: Layout = { id: "all", name: "Everything else" };

describe("chooseLayout", () => {
  it("takes the first enabled layout whose conditions hold, within the plan's cap", () => {
    const order = email("Order 1", "");
    expect(chooseLayout([orders, fallback], 2, order)?.id).toBe("orders");
    expect(chooseLayout([orders, fallback], 2, email("Hello", ""))?.id).toBe("all");
    expect(chooseLayout([{ ...orders, enabled: false }, fallback], 2, order)?.id).toBe("all");
    // Past the cap a layout is kept but never matched.
    expect(chooseLayout([orders, fallback], 1, email("Hello", ""))).toBeNull();
  });

  it("gives up once its time is spent", () => {
    expect(chooseLayout([orders], 2, email("Order 1", ""), null, Date.now() - 1)).toBeNull();
  });
});

describe("lineItemsFromText", () => {
  it("reads rows between the markers, with the groups as columns in order", () => {
    const items = lineItemsFromText(email("Order", "Items:\nA-1 x2\nB-22 x10\nThanks\nZ-9 x1\n"), {
      from: "text",
      pattern: "(?P<sku>[A-Z]-\\d+) x(?P<qty>\\d+)",
      start: "Items:",
      end: "Thanks",
    });
    expect(items.columns).toEqual(["sku", "qty"]);
    expect(items.rows).toEqual([
      { sku: "A-1", qty: "2" },
      { sku: "B-22", qty: "10" },
    ]);
  });

  it("skips empty matches instead of stopping", () => {
    const items = lineItemsFromText(email("Order", "x\nA-1 2\n\nB-2 3\n"), {
      from: "text",
      pattern: "(?P<sku>[A-Z]-\\d+)? ?(?P<qty>\\d*)",
    });
    expect(items.rows.filter((row) => row.sku)).toEqual([
      { sku: "A-1", qty: "2" },
      { sku: "B-2", qty: "3" },
    ]);
  });

  it("stops at its time limit and says so", () => {
    const items = lineItemsFromText(
      email("Order", "x".repeat(10_000)),
      { from: "text", pattern: "(?P<a>(?:b*c)?)" },
      Date.now() - 1
    );
    expect(items.rows).toEqual([]);
    expect(items.truncated).toBe(true);
  });

  it("keeps a group named __proto__ as a column", () => {
    const items = lineItemsFromText(email("Order", "k=v"), {
      from: "text",
      pattern: "(?P<__proto__>\\w)=(?P<b>\\w)",
    });
    expect(Object.keys(items.rows[0])).toEqual(["__proto__", "b"]);
    expect(Object.getPrototypeOf(items.rows[0])).toBe(Object.prototype);
  });
});

describe("lineItemsFromSheets", () => {
  const sheet = {
    name: "Orders",
    rows: [
      ["SKU", "Qty", "__proto__"],
      ["A-1", "2", "x"],
    ],
    rowCount: 2,
    truncated: false,
  };
  const file = (filename: string) => ({
    parsed: { index: 0, filename, format: "csv", pages: 1 },
    sheets: [sheet],
  });

  it("maps columns by header or letter, in the order given", () => {
    const items = lineItemsFromSheets(
      {
        from: "attachment",
        attachment: "*.CSV",
        columns: [
          { name: "qty", column: "qty" },
          { name: "sku", column: "A" },
        ],
      },
      [file("order.csv")]
    );
    expect(items.columns).toEqual(["qty", "sku"]);
    expect(items.rows).toEqual([{ qty: "2", sku: "A-1" }]);
  });

  it("keeps every column by its header, __proto__ included", () => {
    const items = lineItemsFromSheets({ from: "attachment" }, [file("order.csv")]);
    expect(items.columns).toEqual(["SKU", "Qty", "__proto__"]);
    expect(Object.keys(items.rows[0])).toEqual(["SKU", "Qty", "__proto__"]);
  });

  it("keeps at most 30 columns with short, distinct names", () => {
    const header = Array.from({ length: 40 }, (_, i) => (i < 2 ? "Same" : "n".repeat(500) + i));
    const items = lineItemsFromSheets({ from: "attachment" }, [
      {
        parsed: { index: 0, filename: "w.csv", format: "csv", pages: 1 },
        sheets: [{ name: null, rows: [header, header], rowCount: 2, truncated: false }],
      },
    ]);
    expect(items.columns).toHaveLength(30);
    expect(items.columns.slice(0, 2)).toEqual(["Same", "Same_2"]);
    expect(Math.max(...items.columns.map((name) => name.length))).toBeLessThanOrEqual(100);
  });

  it("reads only files matching the wildcard", () => {
    expect(
      lineItemsFromSheets({ from: "attachment", attachment: "*.xlsx" }, [file("order.csv")])
    ).toEqual({ rows: [], columns: [] });
    expect(attachmentMatcher("orders-*.csv")("Orders-2026.csv")).toBe(true);
    expect(attachmentMatcher("orders-*.csv")("terms.pdf")).toBe(false);
    expect(attachmentMatcher(undefined)("anything")).toBe(true);
  });
});

describe("layoutsProblems", () => {
  it("allows more layouts than a plan uses, up to 50", () => {
    expect(layoutsProblems([orders, fallback, { id: "x", name: "Third" }])).toEqual([]);
  });

  it("checks match regexes with RE2", () => {
    const problems = layoutsProblems([
      {
        ...orders,
        match: {
          conditions: [{ field: "email", name: "subject", op: "regex", value: "(?<=x)y" }],
        },
      },
    ]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/^layout 1: match\.conditions/);
  });
});
