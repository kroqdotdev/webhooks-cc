import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhooksCC } from "../client";
import { CheckoutExpiredError } from "../errors";

const BASE_URL = "https://test.webhooks.cc";
const ID = "11111111-2222-4333-8444-555555555555";

function client() {
  return new WebhooksCC({ apiKey: "whcc_testkey123", baseUrl: BASE_URL });
}

function answer(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function link(status: "open" | "paid" | "expired") {
  return {
    checkout: {
      id: ID,
      status,
      kind: "plan",
      summary: "The Pro plan, billed monthly.",
      item: { kind: "plan", plan: "pro", interval: "month" },
      teamId: null,
      url: status === "open" ? "https://polar.sh/checkout/polar_c_x" : null,
      createdAt: "2026-11-14T12:00:00.000Z",
      expiresAt: "2026-11-14T13:00:00.000Z",
      paidAt: status === "paid" ? "2026-11-14T12:05:00.000Z" : null,
    },
  };
}

describe("billing checkout links", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("makes a link, then waits until the person pays", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer(link("open"), 201))
      .mockResolvedValueOnce(answer(link("open")))
      .mockResolvedValueOnce(answer(link("paid")));
    globalThis.fetch = fetchMock;

    const checkout = await client().billing.createCheckout({ kind: "plan", plan: "pro" });
    expect(checkout.url).toBe("https://polar.sh/checkout/polar_c_x");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/billing/checkouts`);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ kind: "plan", plan: "pro" });

    const paid = await client().billing.waitForCheckout(ID, { pollInterval: 1_000 });
    expect(paid.status).toBe("paid");
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE_URL}/api/billing/checkouts/${ID}`);
  });

  it("throws when the link expires, or the wait runs out", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(answer(link("expired")));
    await expect(client().billing.waitForCheckout(ID)).rejects.toBeInstanceOf(CheckoutExpiredError);
    globalThis.fetch = vi.fn().mockResolvedValue(answer(link("open")));
    await expect(client().billing.waitForCheckout(ID, { timeout: 0 })).rejects.toThrow("Timed out");
  });

  it("refuses an id that is not a path segment", async () => {
    globalThis.fetch = vi.fn();
    await expect(client().billing.getCheckout("../approvals")).rejects.toThrow();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
