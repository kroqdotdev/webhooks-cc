import { describe, expect, it } from "vitest";
import type { RequestRecord } from "@/lib/supabase/requests";
import { RowsTooLargeError, rowsFor } from "./sheets";

const request = (text: string, items: number): RequestRecord =>
  ({
    id: "6b3f2c1e-0000-4000-8000-000000000003",
    endpointId: "e1",
    method: "EMAIL",
    path: "acme-orders@mailhooks.cc",
    headers: { subject: "Order 1001" },
    body: text,
    queryParams: {},
    ip: "203.0.113.9",
    size: text.length,
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
      text,
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
      fields: {},
      lineItems: Array.from({ length: items }, (_, i) => ({ sku: `A-${i}` })),
      lineItemColumns: ["sku"],
      attachments: [],
      pages: 0,
    },
  }) as unknown as RequestRecord;

const endpoint = { slug: "acme-orders", name: "Orders" };

describe("rowsFor limits", () => {
  it("cuts a long value to a cell's size while filling it in", () => {
    const [[cell]] = rowsFor(
      request("x".repeat(200_000), 0),
      { rows: "email", columns: [{ header: "Text", value: "{{ text }}" }] },
      endpoint,
      { includeExtracts: false, fields: null }
    );
    expect(cell).toHaveLength(50_000);
  });

  it("refuses rows past the size they may take, before building them all", () => {
    const columns = [
      { header: "SKU", value: "{{ item.sku }}" },
      { header: "Text", value: "{{ text }}" },
    ];
    // 1,000 line items, each repeating 10,000 characters of text.
    expect(() =>
      rowsFor(request("y".repeat(10_000), 1000), { rows: "line_items", columns }, endpoint, {
        includeExtracts: false,
        fields: null,
        maxChars: 1_000_000,
      })
    ).toThrow(RowsTooLargeError);
    expect(
      rowsFor(request("y".repeat(10), 3), { rows: "line_items", columns }, endpoint, {
        includeExtracts: false,
        fields: null,
        maxChars: 1_000_000,
      })
    ).toHaveLength(3);
  });
});
