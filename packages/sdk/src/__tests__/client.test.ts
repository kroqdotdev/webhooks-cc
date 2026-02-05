import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebhooksCC, ApiError } from "../client";

const API_KEY = "whcc_testkey123";
const BASE_URL = "https://test.webhooks.cc";

function createClient(opts?: { timeout?: number }) {
  return new WebhooksCC({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    ...opts,
  });
}

function mockFetch(response: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const status = response.status ?? 200;
  const headers = new Headers({
    "content-type": "application/json",
    ...response.headers,
  });

  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(JSON.stringify(response.body)),
  });
}

describe("WebhooksCC", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("endpoints.create", () => {
    it("sends POST /api/endpoints with auth header", async () => {
      const endpoint = { id: "ep1", slug: "abc123", url: "https://r.webhooks.cc/w/abc123", createdAt: Date.now() };
      const fetchMock = mockFetch({ body: endpoint });
      globalThis.fetch = fetchMock;

      const client = createClient();
      const result = await client.endpoints.create({ name: "Test" });

      expect(result).toEqual(endpoint);
      expect(fetchMock).toHaveBeenCalledOnce();

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/endpoints`);
      expect(opts.method).toBe("POST");
      expect(opts.headers.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(JSON.parse(opts.body)).toEqual({ name: "Test" });
    });

    it("sends POST with empty options when none provided", async () => {
      const endpoint = { id: "ep1", slug: "abc123", url: "https://r.webhooks.cc/w/abc123", createdAt: Date.now() };
      const fetchMock = mockFetch({ body: endpoint });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.endpoints.create();

      const [, opts] = fetchMock.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual({});
    });
  });

  describe("endpoints.list", () => {
    it("sends GET /api/endpoints", async () => {
      const endpoints = [{ id: "ep1", slug: "abc", url: "https://r.webhooks.cc/w/abc", createdAt: Date.now() }];
      const fetchMock = mockFetch({ body: endpoints });
      globalThis.fetch = fetchMock;

      const client = createClient();
      const result = await client.endpoints.list();

      expect(result).toEqual(endpoints);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/endpoints`);
      expect(opts.method).toBe("GET");
    });
  });

  describe("endpoints.get", () => {
    it("sends GET /api/endpoints/{slug}", async () => {
      const endpoint = { id: "ep1", slug: "abc123", url: "https://r.webhooks.cc/w/abc123", createdAt: Date.now() };
      const fetchMock = mockFetch({ body: endpoint });
      globalThis.fetch = fetchMock;

      const client = createClient();
      const result = await client.endpoints.get("abc123");

      expect(result).toEqual(endpoint);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/endpoints/abc123`);
    });

    it("rejects invalid slug characters", async () => {
      const client = createClient();
      await expect(client.endpoints.get("../admin")).rejects.toThrow("Invalid slug");
    });

    it("rejects slugs with slashes", async () => {
      const client = createClient();
      await expect(client.endpoints.get("foo/bar")).rejects.toThrow("Invalid slug");
    });
  });

  describe("endpoints.delete", () => {
    it("sends DELETE /api/endpoints/{slug}", async () => {
      const fetchMock = mockFetch({ status: 204, body: undefined, headers: { "content-length": "0" } });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.endpoints.delete("abc123");

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/endpoints/abc123`);
      expect(opts.method).toBe("DELETE");
    });
  });

  describe("requests.list", () => {
    it("sends GET /api/endpoints/{slug}/requests with query params", async () => {
      const requests = [{ id: "r1", method: "POST", receivedAt: Date.now() }];
      const fetchMock = mockFetch({ body: requests });
      globalThis.fetch = fetchMock;

      const client = createClient();
      const result = await client.requests.list("abc123", { limit: 10, since: 1000 });

      expect(result).toEqual(requests);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/endpoints/abc123/requests?limit=10&since=1000`);
    });

    it("sends GET without query params when none provided", async () => {
      const fetchMock = mockFetch({ body: [] });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.requests.list("abc123");

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/endpoints/abc123/requests`);
    });
  });

  describe("requests.get", () => {
    it("sends GET /api/requests/{id}", async () => {
      const request = { id: "r1", method: "POST" };
      const fetchMock = mockFetch({ body: request });
      globalThis.fetch = fetchMock;

      const client = createClient();
      const result = await client.requests.get("r1");

      expect(result).toEqual(request);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/requests/r1`);
    });
  });

  describe("requests.waitFor", () => {
    it("returns first matching request", async () => {
      const req1 = { id: "r1", method: "GET", receivedAt: 1000 };
      const req2 = { id: "r2", method: "POST", receivedAt: 2000 };

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        const body = callCount === 1 ? [] : [req1, req2];
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(JSON.stringify(body)),
        });
      });

      const client = createClient();
      const result = await client.requests.waitFor("abc123", {
        timeout: 5000,
        pollInterval: 10,
        match: (r) => r.method === "POST",
      });

      expect(result.id).toBe("r2");
    });

    it("returns first request when no match filter", async () => {
      const req = { id: "r1", method: "POST", receivedAt: Date.now() };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve([req]),
        text: () => Promise.resolve(JSON.stringify([req])),
      });

      const client = createClient();
      const result = await client.requests.waitFor("abc123", {
        timeout: 5000,
        pollInterval: 10,
      });

      expect(result.id).toBe("r1");
    });

    it("throws on timeout", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve([]),
        text: () => Promise.resolve("[]"),
      });

      const client = createClient();
      await expect(
        client.requests.waitFor("abc123", { timeout: 50, pollInterval: 10 })
      ).rejects.toThrow(/Timeout/i);
    });

    it("throws on 401 instead of retrying", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ error: "unauthorized" }),
        text: () => Promise.resolve('{"error":"unauthorized"}'),
      });

      const client = createClient();
      await expect(
        client.requests.waitFor("abc123", { timeout: 5000, pollInterval: 10 })
      ).rejects.toThrow(/Authentication failed/i);
    });

    it("throws on 404 instead of retrying", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ error: "not_found" }),
        text: () => Promise.resolve('{"error":"not_found"}'),
      });

      const client = createClient();
      await expect(
        client.requests.waitFor("abc123", { timeout: 5000, pollInterval: 10 })
      ).rejects.toThrow(/not found/i);
    });

    it("continues polling on 5xx errors", async () => {
      const req = { id: "r1", method: "POST", receivedAt: Date.now() };
      let callCount = 0;

      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 500,
            headers: new Headers({ "content-type": "application/json" }),
            json: () => Promise.resolve({ error: "internal" }),
            text: () => Promise.resolve('{"error":"internal"}'),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve([req]),
          text: () => Promise.resolve(JSON.stringify([req])),
        });
      });

      const client = createClient();
      const result = await client.requests.waitFor("abc123", {
        timeout: 5000,
        pollInterval: 10,
      });

      expect(result.id).toBe("r1");
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("error handling", () => {
    it("throws ApiError with status code on non-ok response", async () => {
      const fetchMock = mockFetch({ status: 400, body: { error: "bad request" } });
      globalThis.fetch = fetchMock;

      const client = createClient();
      try {
        await client.endpoints.list();
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).statusCode).toBe(400);
      }
    });

    it("truncates long error messages", async () => {
      const longError = "x".repeat(500);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ error: longError }),
        text: () => Promise.resolve(longError),
      });

      const client = createClient();
      try {
        await client.endpoints.list();
        expect.fail("Should have thrown");
      } catch (error) {
        expect((error as ApiError).message.length).toBeLessThan(300);
      }
    });
  });

  describe("path validation", () => {
    it("rejects path traversal in slug", async () => {
      const client = createClient();
      await expect(client.endpoints.get("..")).rejects.toThrow();
      await expect(client.endpoints.delete("../admin")).rejects.toThrow();
      await expect(client.requests.list("../admin")).rejects.toThrow();
      await expect(client.requests.get("../admin")).rejects.toThrow();
    });

    it("accepts valid slugs", async () => {
      const fetchMock = mockFetch({ body: {} });
      globalThis.fetch = fetchMock;

      const client = createClient();
      // These should not throw validation errors
      await client.endpoints.get("abc-123");
      await client.endpoints.get("test_slug");
      await client.endpoints.get("ABC123");
    });
  });
});
