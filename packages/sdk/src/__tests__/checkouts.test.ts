import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhooksCC } from "../client";
import { CheckoutExpiredError, CheckoutSupersededError } from "../errors";

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

function link(
  status: "open" | "paid" | "expired" | "superseded",
  overrides: Record<string, unknown> = {}
) {
  return {
    checkout: {
      id: ID,
      status,
      kind: "plan",
      summary: "The Pro plan, billed monthly.",
      item: { kind: "plan", plan: "pro", interval: "month" },
      teamId: null,
      url: status === "open" ? `https://webhooks.cc/checkout/${ID}` : null,
      opened: status !== "open",
      createdAt: "2026-11-14T12:00:00.000Z",
      // Expired a minute ago: a late payment may still land.
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      paidAt: status === "paid" ? "2026-11-14T12:05:00.000Z" : null,
      bought:
        status === "paid"
          ? { product: "prod_pro", seats: null, units: null, amount: 900, currency: "usd" }
          : null,
      matches: status === "paid" ? true : null,
      ...overrides,
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
    // Our page, which the person opens signed in; never Polar's checkout.
    expect(checkout.url).toBe(`https://webhooks.cc/checkout/${ID}`);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/billing/checkouts`);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ kind: "plan", plan: "pro" });

    const paid = await client().billing.waitForCheckout(ID, { pollInterval: 1_000 });
    expect(paid.status).toBe("paid");
    expect(paid).toMatchObject({ bought: { amount: 900 }, matches: true });
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE_URL}/api/billing/checkouts/${ID}`);
  });

  it("throws when the link expires, or the wait runs out", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(answer(link("expired")));
    await expect(client().billing.waitForCheckout(ID, { expiredGrace: 0 })).rejects.toBeInstanceOf(
      CheckoutExpiredError
    );
    // A wait that runs out while the link reads expired says it expired.
    await expect(
      client().billing.waitForCheckout(ID, { timeout: 1_500, pollInterval: 1_000 })
    ).rejects.toBeInstanceOf(CheckoutExpiredError);
    globalThis.fetch = vi.fn().mockResolvedValue(answer(link("open")));
    await expect(client().billing.waitForCheckout(ID, { timeout: 0 })).rejects.toThrow("Timed out");
  });

  it("keeps polling a link that reads expired, since a late payment can still turn it paid", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer(link("expired")))
      .mockResolvedValueOnce(answer(link("paid")));
    globalThis.fetch = fetchMock;
    const paid = await client().billing.waitForCheckout(ID, { pollInterval: 1_000 });
    expect(paid.status).toBe("paid");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws at once for an expired link no late payment can turn paid", async () => {
    for (const overrides of [
      // Never opened: there is no Polar checkout to pay.
      { opened: false },
      // Expired an hour ago: past any late payment.
      { expiresAt: new Date(Date.now() - 60 * 60_000).toISOString() },
    ]) {
      const fetchMock = vi.fn().mockResolvedValue(answer(link("expired", overrides)));
      globalThis.fetch = fetchMock;
      await expect(
        client().billing.waitForCheckout(ID, { pollInterval: 1_000 })
      ).rejects.toBeInstanceOf(CheckoutExpiredError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("stops at once when aborted, during a poll or between polls", async () => {
    // Between polls: the wait never sits out its interval.
    globalThis.fetch = vi.fn().mockResolvedValue(answer(link("open")));
    const between = new AbortController();
    const started = Date.now();
    const waiting = client().billing.waitForCheckout(ID, {
      pollInterval: 30_000,
      signal: between.signal,
    });
    setTimeout(() => between.abort(new Error("stop")), 50);
    await expect(waiting).rejects.toThrow("stop");
    expect(Date.now() - started).toBeLessThan(5_000);

    // During a poll that would answer paid: the abort wins.
    const during = new AbortController();
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
          setTimeout(() => resolve(answer(link("paid"))), 10_000);
        })
    );
    const polling = client().billing.waitForCheckout(ID, { signal: during.signal });
    setTimeout(() => during.abort(new Error("stop")), 50);
    await expect(polling).rejects.toThrow("stop");
  });

  it("never retries a timed poll that ran out after a backoff", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        })
    );
    const slow = new WebhooksCC({
      apiKey: "whcc_testkey123",
      baseUrl: BASE_URL,
      retry: { maxAttempts: 3, backoffMs: 5_000 },
    });
    const started = Date.now();
    await expect(slow.billing.getCheckout(ID, { timeout: 200 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through our side failing, a rate limit or the network", async () => {
    // No retries of the client's own: the wait itself asks again.
    const once = new WebhooksCC({
      apiKey: "whcc_testkey123",
      baseUrl: BASE_URL,
      retry: { maxAttempts: 1 },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer({ error: "busy" }, 503))
      .mockResolvedValueOnce(answer({ error: "slow down" }, 429))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(answer(link("paid")));
    globalThis.fetch = fetchMock;
    const paid = await once.billing.waitForCheckout(ID, { pollInterval: 1_000, timeout: 10_000 });
    expect(paid.status).toBe("paid");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Until the deadline: then it is a timeout, not the last failure.
    globalThis.fetch = vi.fn().mockResolvedValue(answer({ error: "busy" }, 503));
    await expect(
      once.billing.waitForCheckout(ID, { pollInterval: 1_000, timeout: 1_500 })
    ).rejects.toThrow("Timed out");

    // A refusal is final.
    const refused = vi.fn().mockResolvedValue(answer({ error: "Checkout link not found" }, 404));
    globalThis.fetch = refused;
    await expect(
      once.billing.waitForCheckout(ID, { pollInterval: 1_000, timeout: 10_000 })
    ).rejects.toThrow("Checkout link not found");
    expect(refused).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("never says nothing was bought for a link that may have been paid", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      answer(
        link("expired", {
          expiredReason: "unsettled",
          expiresAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        })
      )
    );
    const error = await client()
      .billing.waitForCheckout(ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CheckoutExpiredError);
    expect((error as CheckoutExpiredError).reason).toBe("unsettled");
    expect((error as Error).message).toContain("If the person paid, it is still applied");
    expect((error as Error).message).toContain("has been alerted");

    globalThis.fetch = vi.fn().mockResolvedValue(answer(link("expired", { opened: false })));
    const plain = await client()
      .billing.waitForCheckout(ID)
      .catch((e: unknown) => e);
    expect((plain as CheckoutExpiredError).reason).toBeNull();
  });

  it("throws when the purchase was undone as a duplicate plan", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(answer(link("superseded")));
    const error = await client()
      .billing.waitForCheckout(ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CheckoutSupersededError);
    // Handled wherever an expired link is.
    expect(error).toBeInstanceOf(CheckoutExpiredError);
    // It never promises a refund: refunds are reviewed.
    expect((error as Error).message).toContain("a refund of what it charged is under review");
    expect((error as Error).message).not.toContain("goes back");
  });

  it("cancels a link nobody has opened", async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer(link("expired")));
    globalThis.fetch = fetchMock;
    const cancelled = await client().billing.cancelCheckout(ID);
    expect(cancelled.status).toBe("expired");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/billing/checkouts/${ID}`);
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });

  it("refuses an id that is not a path segment", async () => {
    globalThis.fetch = vi.fn();
    await expect(client().billing.getCheckout("../approvals")).rejects.toThrow();
    await expect(client().billing.cancelCheckout("../approvals")).rejects.toThrow();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
