import { describe, expect, it } from "vitest";
import type { RequestRecord } from "@/lib/supabase/requests";
import { parseSheetsConfig, rowsFor } from "./sheets";

const config = (header: string) => ({
  connectionId: "00000000-0000-4000-8000-000000000000",
  spreadsheetId: "a".repeat(44),
  sheet: "Orders",
  rows: "email",
  columns: [{ header, value: "{{ subject }}" }],
});

describe("parseSheetsConfig", () => {
  it("refuses a blank or whitespace header", () => {
    for (const header of ["", "   "]) {
      expect(parseSheetsConfig(config(header), { http: false, email: true })).toBe(
        "Column 1 needs a header and a value."
      );
    }
  });

  it("keeps a column with a header", () => {
    const parsed = parseSheetsConfig(config("Subject"), { http: false, email: true });
    expect(typeof parsed).toBe("object");
  });
});

describe("rowsFor", () => {
  const order = (lineItems: Record<string, string | null>[]): RequestRecord => ({
    id: "6b3f2c1e-0000-4000-8000-000000000002",
    endpointId: "e1",
    method: "EMAIL",
    path: "acme-orders@mailhooks.cc",
    headers: { subject: "Order 1001" },
    body: "Subject: Order 1001\r\n\r\nThanks.",
    queryParams: {},
    ip: "203.0.113.9",
    size: 40,
    receivedAt: Date.parse("2026-10-10T15:25:09.312Z"),
    kind: "email",
    email: {
      subject: "Order 1001",
      from: [{ name: "Acme Store", address: "orders@acme.example" }],
      to: [{ name: null, address: "acme-orders@mailhooks.cc" }],
      cc: [],
      replyTo: [],
      sender: [],
      date: null,
      messageId: null,
      inReplyTo: [],
      tag: null,
      text: "Thanks.",
      html: null,
      textFromHtml: false,
      attachments: [],
      auth: null,
      smtp: null,
      parseError: false,
      truncated: {
        raw: false,
        text: false,
        html: false,
        headers: false,
        addresses: false,
        attachments: false,
      },
    },
    parsed: {
      status: "matched",
      layout: { id: "l1", name: "Acme orders" },
      fields: { order: "1001" },
      lineItems,
      lineItemColumns: ["sku", "qty"],
      attachments: [],
      pages: 0,
    },
  });
  const endpoint = { slug: "acme-orders", name: "Orders" };
  const options = { includeExtracts: false, fields: null };
  const columns = [
    { header: "Order", value: "{{ parsed.fields.order }}" },
    { header: "SKU", value: "{{ item.sku }}" },
    { header: "Qty", value: "{{ item.qty }}" },
  ];

  it("adds a row per line item, each with the email's own values too", () => {
    const rows = rowsFor(
      order([
        { sku: "A-1", qty: "2" },
        { sku: "B-2", qty: "1" },
        { sku: "C-3", qty: null },
      ]),
      { rows: "line_items", columns },
      endpoint,
      options
    );
    expect(rows).toEqual([
      ["1001", "A-1", "2"],
      ["1001", "B-2", "1"],
      ["1001", "C-3", ""],
    ]);
  });

  it("adds one row for an email with no line items, and one per email when asked", () => {
    expect(rowsFor(order([]), { rows: "line_items", columns }, endpoint, options)).toEqual([
      ["1001", "", ""],
    ]);
    expect(
      rowsFor(
        order([{ sku: "A-1", qty: "2" }]),
        { rows: "email", columns: [columns[0]] },
        endpoint,
        options
      )
    ).toEqual([["1001"]]);
  });
});
