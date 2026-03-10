import { afterEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../errors";
import {
  assertRequest,
  captureDuring,
  withEndpoint,
  withEphemeralEndpoint,
  type AssertRequestExpectation,
} from "../testing";

const endpoint = {
  id: "ep1",
  slug: "endpoint-1",
  url: "https://go.test.webhooks.cc/w/endpoint-1",
  createdAt: Date.now(),
};

const request = {
  id: "req1",
  endpointId: "ep1",
  method: "POST",
  path: "/webhook",
  headers: {
    "content-type": "application/json",
    "x-request-id": "abc",
  },
  body: JSON.stringify({
    type: "payment_intent.succeeded",
    data: { object: { amount: 4999, currency: "usd" } },
  }),
  queryParams: {},
  contentType: "application/json",
  ip: "127.0.0.1",
  size: 42,
  receivedAt: 1000,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("testing helpers", () => {
  it("withEndpoint creates, invokes, and cleans up the endpoint", async () => {
    const client = {
      endpoints: {
        create: vi.fn().mockResolvedValue(endpoint),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      requests: {
        list: vi.fn(),
      },
    };

    const result = await withEndpoint(
      client as never,
      async (created) => {
        expect(created.slug).toBe("endpoint-1");
        return "ok";
      },
      { name: "Test endpoint" }
    );

    expect(result).toBe("ok");
    expect(client.endpoints.create).toHaveBeenCalledWith({ name: "Test endpoint" });
    expect(client.endpoints.delete).toHaveBeenCalledWith("endpoint-1");
  });

  it("withEphemeralEndpoint forces ephemeral creation", async () => {
    const client = {
      endpoints: {
        create: vi.fn().mockResolvedValue(endpoint),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      requests: {
        list: vi.fn(),
      },
    };

    await withEphemeralEndpoint(client as never, async () => undefined, {
      name: "Ephemeral helper",
    });

    expect(client.endpoints.create).toHaveBeenCalledWith({
      name: "Ephemeral helper",
      ephemeral: true,
    });
  });

  it("captureDuring polls until the expected number of requests are captured", async () => {
    vi.useFakeTimers();

    const client = {
      endpoints: {
        create: vi.fn().mockResolvedValue(endpoint),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      requests: {
        list: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ ...request, id: "req2", receivedAt: 1002 }, request]),
      },
    };

    const promise = captureDuring(client as never, async () => undefined, {
      count: 2,
      pollInterval: 10,
    });

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual([request, { ...request, id: "req2", receivedAt: 1002 }]);
    expect(client.requests.list).toHaveBeenCalledTimes(2);
    expect(client.endpoints.delete).toHaveBeenCalledWith("endpoint-1");
  });

  it("swallows missing endpoint errors during cleanup", async () => {
    const client = {
      endpoints: {
        create: vi.fn().mockResolvedValue(endpoint),
        delete: vi.fn().mockRejectedValue(new NotFoundError("missing")),
      },
      requests: {
        list: vi.fn(),
      },
    };

    await expect(withEndpoint(client as never, async () => "ok")).resolves.toBe("ok");
  });

  it("assertRequest treats headers and bodyJson as subset assertions", () => {
    const expected: AssertRequestExpectation = {
      method: "POST",
      path: "/webhook",
      headers: { "content-type": "application/json" },
      bodyJson: { data: { object: { amount: 4999 } } },
    };

    const result = assertRequest(request, expected, {
      ignoreHeaders: ["x-request-id"],
    });

    expect(result.pass).toBe(true);
    expect(result.diff.matches).toBe(true);
  });

  it("assertRequest throws with diff output when requested", () => {
    expect(() =>
      assertRequest(
        request,
        {
          method: "GET",
          bodyJson: { type: "invoice.paid" },
        },
        { throwOnFailure: true }
      )
    ).toThrow(/Request assertion failed/);
  });
});
