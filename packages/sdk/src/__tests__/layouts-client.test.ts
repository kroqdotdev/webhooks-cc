import { describe, expect, it, vi } from "vitest";
import { WebhooksCC } from "../client";
import type { Layout } from "../email/layouts";

const BASE_URL = "https://webhooks.example";

function client(fetchImpl: typeof fetch) {
  return new WebhooksCC({ apiKey: "whcc_test", baseUrl: BASE_URL, fetch: fetchImpl });
}

const ORDERS: Layout = {
  id: "orders",
  name: "Orders",
  match: { conditions: [{ field: "email", name: "subject", op: "contains", value: "Order" }] },
  fields: [{ name: "order", from: "subject", pattern: "Order (\\d+)" }],
  lineItems: { from: "attachment", attachment: "*.csv" },
};

describe("layouts", () => {
  it("previews layouts on a captured email", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${BASE_URL}/api/endpoints/acme/layouts/preview`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ layouts: [ORDERS], requestId: "req-1" });
      return Response.json({
        problems: [],
        layoutsCap: 2,
        request: { id: "req-1", subject: "Order 1", receivedAt: 1 },
        parsed: {
          status: "matched",
          layout: { id: "orders", name: "Orders" },
          fields: { order: "1" },
          lineItems: [{ sku: "A-1" }],
          lineItemColumns: ["sku"],
          attachments: [],
          pages: 0,
        },
      });
    });
    const preview = await client(fetchImpl as unknown as typeof fetch).endpoints.previewLayouts(
      "acme",
      { layouts: [ORDERS], requestId: "req-1" }
    );
    expect(preview.parsed?.fields.order).toBe("1");
    expect(preview.parsed?.lineItemColumns).toEqual(["sku"]);
  });

  it("refuses layouts the API would refuse before sending them", async () => {
    const fetchImpl = vi.fn();
    const api = client(fetchImpl as unknown as typeof fetch);
    await expect(
      api.endpoints.update("acme", { layouts: [ORDERS, { ...ORDERS, name: "Again" }] })
    ).rejects.toThrow(/used twice/);
    await expect(
      api.endpoints.previewLayouts("acme", { layouts: [{ ...ORDERS, id: "no spaces" }] })
    ).rejects.toThrow(/layouts: layout 1/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
