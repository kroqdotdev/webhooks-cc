import { describe, it, expect, beforeAll } from "vitest";
import { WebhooksCC, ApiError } from "../client";
import { WebhooksCCError } from "../errors";
import { matchMethod, matchHeader, matchBodyPath, matchAll, matchAny } from "../matchers";
import {
  isStripeWebhook,
  isGitHubWebhook,
  isShopifyWebhook,
  isSlackWebhook,
  isTwilioWebhook,
  isPaddleWebhook,
  isLinearWebhook,
} from "../helpers";
import { parseDuration } from "../utils";

const API_KEY = process.env.WHK_API_KEY;
const BASE_URL = process.env.WHK_BASE_URL ?? "https://webhooks.cc";
const WEBHOOK_URL = process.env.WHK_WEBHOOK_URL ?? "https://r.webhooks.cc";

describe.skipIf(!API_KEY)("SDK integration tests", () => {
  let client: WebhooksCC;

  beforeAll(() => {
    client = new WebhooksCC({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      webhookUrl: WEBHOOK_URL,
    });
  });

  it("full round-trip: create, send webhook, waitFor, delete", async () => {
    // Create endpoint
    const endpoint = await client.endpoints.create({ name: "Integration Test" });
    expect(endpoint.slug).toBeTruthy();
    expect(endpoint.url).toBeDefined();
    expect(endpoint.url).toContain(endpoint.slug);

    try {
      // Send a webhook to the endpoint
      const webhookUrl = `${WEBHOOK_URL}/w/${endpoint.slug}`;
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true, timestamp: Date.now() }),
      });

      // Wait for the request to arrive
      const request = await client.requests.waitFor(endpoint.slug, {
        timeout: 10000,
        pollInterval: 200,
        match: (r) => r.method === "POST",
      });

      expect(request.method).toBe("POST");
      expect(request.body).toBeTruthy();
      const body = JSON.parse(request.body!);
      expect(body.test).toBe(true);

      // Verify list works
      const requests = await client.requests.list(endpoint.slug);
      expect(requests.length).toBeGreaterThanOrEqual(1);

      // Verify get by slug works
      const fetched = await client.endpoints.get(endpoint.slug);
      expect(fetched.slug).toBe(endpoint.slug);

      // Verify list endpoints works
      const endpoints = await client.endpoints.list();
      expect(endpoints.some((e) => e.slug === endpoint.slug)).toBe(true);
    } finally {
      // Cleanup
      await client.endpoints.delete(endpoint.slug);
    }

    // Verify deletion
    try {
      await client.endpoints.get(endpoint.slug);
      expect.fail("Should have thrown 404");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as WebhooksCCError).statusCode).toBe(404);
    }
  }, 30000);

  it("returns 404 for non-existent slug", async () => {
    try {
      await client.endpoints.get("nonexistent-slug-xyz");
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as WebhooksCCError).statusCode).toBe(404);
    }
  });

  it("returns 401 for invalid API key", async () => {
    const badClient = new WebhooksCC({
      apiKey: "whcc_invalid_key",
      baseUrl: BASE_URL,
    });

    try {
      await badClient.endpoints.list();
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as WebhooksCCError).statusCode).toBe(401);
    }
  });

  it("endpoints.update: rename an endpoint", async () => {
    const endpoint = await client.endpoints.create({ name: "Before Update" });
    try {
      const updated = await client.endpoints.update(endpoint.slug, { name: "After Update" });
      expect(updated.name).toBe("After Update");
      expect(updated.slug).toBe(endpoint.slug);
    } finally {
      await client.endpoints.delete(endpoint.slug);
    }
  }, 15000);

  it("endpoints.update: set and clear mock response", async () => {
    const endpoint = await client.endpoints.create({ name: "Mock Test" });
    try {
      // Set mock
      const withMock = await client.endpoints.update(endpoint.slug, {
        mockResponse: { status: 201, body: '{"ok":true}', headers: {} },
      });
      expect(withMock.slug).toBe(endpoint.slug);

      // Send a request and verify mock response
      const res = await client.endpoints.send(endpoint.slug, {
        method: "POST",
        body: { check: "mock" },
      });
      expect(res.status).toBe(201);

      // Clear mock
      const cleared = await client.endpoints.update(endpoint.slug, { mockResponse: null });
      expect(cleared.slug).toBe(endpoint.slug);
    } finally {
      await client.endpoints.delete(endpoint.slug);
    }
  }, 15000);

  it("endpoints.send: sends test webhook and captures it", async () => {
    const endpoint = await client.endpoints.create({ name: "Send Test" });
    try {
      await client.endpoints.send(endpoint.slug, {
        method: "POST",
        headers: { "x-test-id": "send-integration" },
        body: { source: "sdk-test" },
      });

      const request = await client.requests.waitFor(endpoint.slug, {
        timeout: "10s",
        pollInterval: "200ms",
        match: matchHeader("x-test-id", "send-integration"),
      });

      expect(request.method).toBe("POST");
      const body = JSON.parse(request.body!);
      expect(body.source).toBe("sdk-test");
    } finally {
      await client.endpoints.delete(endpoint.slug);
    }
  }, 20000);

  it("requests.replay: replays a captured request", async () => {
    const endpoint = await client.endpoints.create({ name: "Replay Source" });
    const target = await client.endpoints.create({ name: "Replay Target" });
    try {
      // Send a request to the source endpoint
      await client.endpoints.send(endpoint.slug, {
        method: "POST",
        headers: { "x-replay-test": "original" },
        body: { action: "replay-me" },
      });

      // Wait for capture
      const captured = await client.requests.waitFor(endpoint.slug, {
        timeout: "10s",
        match: matchHeader("x-replay-test"),
      });

      // Replay to the target endpoint
      const targetUrl = `${WEBHOOK_URL}/w/${target.slug}`;
      const replayResponse = await client.requests.replay(captured.id, targetUrl);
      expect(replayResponse.status).toBeGreaterThanOrEqual(200);
      expect(replayResponse.status).toBeLessThan(300);

      // Verify the replayed request arrived at the target
      const replayed = await client.requests.waitFor(target.slug, {
        timeout: "10s",
      });
      expect(replayed.method).toBe("POST");
    } finally {
      await client.endpoints.delete(endpoint.slug);
      await client.endpoints.delete(target.slug);
    }
  }, 30000);

  it("waitFor with human-readable duration strings", async () => {
    const endpoint = await client.endpoints.create({ name: "Duration Test" });
    try {
      await client.endpoints.send(endpoint.slug, {
        method: "POST",
        body: { duration: "test" },
      });

      const request = await client.requests.waitFor(endpoint.slug, {
        timeout: "15s",
        pollInterval: "500ms",
      });

      expect(request.method).toBe("POST");
    } finally {
      await client.endpoints.delete(endpoint.slug);
    }
  }, 20000);

  it("matchers: composable request matching", async () => {
    const endpoint = await client.endpoints.create({ name: "Matcher Test" });
    try {
      // Send request with specific headers and body
      await client.endpoints.send(endpoint.slug, {
        method: "POST",
        headers: { "x-event-type": "payment.success" },
        body: { event: "payment.success", amount: 4999 },
      });

      // Use composed matchers
      const request = await client.requests.waitFor(endpoint.slug, {
        timeout: "10s",
        match: matchAll(matchMethod("POST"), matchHeader("x-event-type", "payment.success")),
      });

      expect(request.method).toBe("POST");
      const body = JSON.parse(request.body!);
      expect(body.amount).toBe(4999);
    } finally {
      await client.endpoints.delete(endpoint.slug);
    }
  }, 20000);

  it("describe: returns SDK description without API call", () => {
    const description = client.describe();

    expect(description.version).toBe("0.3.0");
    expect(description.endpoints).toBeDefined();
    expect(description.requests).toBeDefined();
    expect(Object.keys(description.endpoints).length).toBe(6);
    expect(Object.keys(description.requests).length).toBe(5);

    // Verify structure
    const createOp = description.endpoints.create;
    expect(createOp.description).toBeTruthy();
    expect(createOp.params).toBeDefined();
  });

  it("provider detection helpers work on requests", async () => {
    const endpoint = await client.endpoints.create({ name: "Provider Test" });
    try {
      // Send with Stripe header
      await client.endpoints.send(endpoint.slug, {
        method: "POST",
        headers: { "stripe-signature": "t=123,v1=abc" },
        body: { type: "checkout.session.completed" },
      });

      const request = await client.requests.waitFor(endpoint.slug, {
        timeout: "10s",
        match: matchHeader("stripe-signature"),
      });

      expect(isStripeWebhook(request)).toBe(true);
      expect(isGitHubWebhook(request)).toBe(false);
      expect(isShopifyWebhook(request)).toBe(false);
      expect(isSlackWebhook(request)).toBe(false);
      expect(isTwilioWebhook(request)).toBe(false);
      expect(isPaddleWebhook(request)).toBe(false);
      expect(isLinearWebhook(request)).toBe(false);
    } finally {
      await client.endpoints.delete(endpoint.slug);
    }
  }, 20000);

  it("actionable error: 401 includes recovery hint", async () => {
    const badClient = new WebhooksCC({
      apiKey: "whcc_bad",
      baseUrl: BASE_URL,
    });

    try {
      await badClient.endpoints.list();
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WebhooksCCError);
      const err = error as WebhooksCCError;
      expect(err.statusCode).toBe(401);
      // Actionable hint should mention getting an API key
      expect(err.message.toLowerCase()).toMatch(/api.key|unauthorized/i);
    }
  });

  it("actionable error: 404 includes recovery hint", async () => {
    try {
      await client.endpoints.get("definitely-not-a-real-slug-xyz");
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WebhooksCCError);
      const err = error as WebhooksCCError;
      expect(err.statusCode).toBe(404);
    }
  });
});

// These run without an API key — pure unit tests bundled here for convenience
describe("parseDuration (unit)", () => {
  it("passes through numbers", () => {
    expect(parseDuration(5000)).toBe(5000);
  });

  it("parses string durations", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("30s")).toBe(30000);
    expect(parseDuration("5m")).toBe(300000);
    expect(parseDuration("1h")).toBe(3600000);
  });

  it("throws on invalid input", () => {
    expect(() => parseDuration("abc")).toThrow();
    expect(() => parseDuration("10x")).toThrow();
  });
});

describe("matchers (unit)", () => {
  const mockRequest = {
    id: "test",
    endpointId: "ep",
    method: "POST",
    path: "/test",
    headers: { "content-type": "application/json", "x-github-event": "push" },
    body: '{"action":"opened","nested":{"id":"123"}}',
    queryParams: {},
    ip: "127.0.0.1",
    size: 100,
    receivedAt: Date.now(),
  };

  it("matchMethod", () => {
    expect(matchMethod("POST")(mockRequest)).toBe(true);
    expect(matchMethod("GET")(mockRequest)).toBe(false);
  });

  it("matchHeader presence", () => {
    expect(matchHeader("x-github-event")(mockRequest)).toBe(true);
    expect(matchHeader("x-missing")(mockRequest)).toBe(false);
  });

  it("matchHeader value", () => {
    expect(matchHeader("x-github-event", "push")(mockRequest)).toBe(true);
    expect(matchHeader("x-github-event", "pull")(mockRequest)).toBe(false);
  });

  it("matchBodyPath", () => {
    expect(matchBodyPath("nested.id", "123")(mockRequest)).toBe(true);
    expect(matchBodyPath("nested.id", "456")(mockRequest)).toBe(false);
  });

  it("matchAll", () => {
    const matcher = matchAll(matchMethod("POST"), matchHeader("x-github-event"));
    expect(matcher(mockRequest)).toBe(true);
  });

  it("matchAny", () => {
    const matcher = matchAny(matchMethod("GET"), matchHeader("x-github-event"));
    expect(matcher(mockRequest)).toBe(true);
  });
});
