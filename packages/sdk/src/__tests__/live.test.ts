/**
 * Comprehensive live tests for @webhooks-cc/sdk v0.3.0
 * Covers every client method and edge case against the production API.
 *
 * Run with: WHK_API_KEY=whcc_... pnpm test -- src/__tests__/live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebhooksCC } from "../client";
import {
  WebhooksCCError,
  UnauthorizedError,
  NotFoundError,
  TimeoutError,
} from "../errors";
import {
  matchMethod,
  matchHeader,
  matchBodyPath,
  matchAll,
  matchAny,
  matchJsonField,
} from "../matchers";
import {
  parseJsonBody,
  isStripeWebhook,
  isGitHubWebhook,
  isShopifyWebhook,
  isSlackWebhook,
  isTwilioWebhook,
  isPaddleWebhook,
  isLinearWebhook,
} from "../helpers";

const API_KEY = process.env.WHK_API_KEY;
const BASE_URL = process.env.WHK_BASE_URL ?? "https://webhooks.cc";
const WEBHOOK_URL = process.env.WHK_WEBHOOK_URL ?? "https://go.webhooks.cc";

// Track all endpoints for cleanup
const createdSlugs: string[] = [];

describe.skipIf(!API_KEY)("Live SDK tests", () => {
  let client: WebhooksCC;

  beforeAll(() => {
    client = new WebhooksCC({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      webhookUrl: WEBHOOK_URL,
    });
  });

  afterAll(async () => {
    // Cleanup any leftover endpoints
    for (const slug of createdSlugs) {
      try {
        await client.endpoints.delete(slug);
      } catch {
        // Already deleted
      }
    }
  });

  // ── Endpoint CRUD ────────────────────────────────────────────────

  describe("endpoints", () => {
    it("create: with name", async () => {
      const ep = await client.endpoints.create({ name: "Live Test EP" });
      createdSlugs.push(ep.slug);

      expect(ep.id).toBeTruthy();
      expect(ep.slug).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(ep.name).toBe("Live Test EP");
      expect(ep.url).toContain(ep.slug);
      expect(ep.createdAt).toBeTypeOf("number");
      expect(ep.createdAt).toBeGreaterThan(0);

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    });

    it("create: without name", async () => {
      const ep = await client.endpoints.create();
      createdSlugs.push(ep.slug);

      expect(ep.slug).toBeTruthy();

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    });

    it("get: returns endpoint details", async () => {
      const ep = await client.endpoints.create({ name: "Get Test" });
      createdSlugs.push(ep.slug);

      const fetched = await client.endpoints.get(ep.slug);
      expect(fetched.slug).toBe(ep.slug);
      expect(fetched.id).toBe(ep.id);

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    });

    it("get: 404 for non-existent slug", async () => {
      try {
        await client.endpoints.get("nonexistent-slug-zzz");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundError);
        expect((error as NotFoundError).statusCode).toBe(404);
      }
    });

    it("list: returns array including created endpoint", async () => {
      const ep = await client.endpoints.create({ name: "List Test" });
      createdSlugs.push(ep.slug);

      const list = await client.endpoints.list();
      expect(Array.isArray(list)).toBe(true);
      expect(list.some((e) => e.slug === ep.slug)).toBe(true);

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    });

    it("update: rename endpoint", async () => {
      const ep = await client.endpoints.create({ name: "Original Name" });
      createdSlugs.push(ep.slug);

      const updated = await client.endpoints.update(ep.slug, {
        name: "Renamed",
      });
      expect(updated.name).toBe("Renamed");
      expect(updated.slug).toBe(ep.slug);

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    });

    it("update: set mock response then verify it works", async () => {
      const ep = await client.endpoints.create({ name: "Mock EP" });
      createdSlugs.push(ep.slug);

      await client.endpoints.update(ep.slug, {
        mockResponse: {
          status: 418,
          body: '{"im":"a teapot"}',
          headers: { "X-Teapot": "yes" },
        },
      });

      // Wait a moment for cache invalidation to propagate
      await new Promise((r) => setTimeout(r, 1500));

      const res = await client.endpoints.send(ep.slug, {
        method: "POST",
        body: { test: true },
      });
      expect(res.status).toBe(418);
      const resBody = await res.text();
      expect(resBody).toContain("teapot");

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    }, 20000);

    it("update: clear mock response", async () => {
      const ep = await client.endpoints.create({ name: "Clear Mock" });
      createdSlugs.push(ep.slug);

      // Set mock
      await client.endpoints.update(ep.slug, {
        mockResponse: { status: 201, body: "created", headers: {} },
      });

      // Clear mock
      const cleared = await client.endpoints.update(ep.slug, {
        mockResponse: null,
      });
      expect(cleared.slug).toBe(ep.slug);

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    });

    it("delete: removes endpoint", async () => {
      const ep = await client.endpoints.create({ name: "Delete Me" });

      await client.endpoints.delete(ep.slug);

      try {
        await client.endpoints.get(ep.slug);
        expect.fail("Should have thrown 404");
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundError);
      }
    });

    it("delete: double delete does not crash", async () => {
      const ep = await client.endpoints.create({ name: "Double Delete" });
      await client.endpoints.delete(ep.slug);

      // Second delete may succeed (no-op) or throw — either is acceptable
      try {
        await client.endpoints.delete(ep.slug);
        // If it succeeds, that's fine (server treats as idempotent)
      } catch (error) {
        // If it throws, should be a proper SDK error
        expect(error).toBeInstanceOf(WebhooksCCError);
      }
    });
  });

  // ── Send ─────────────────────────────────────────────────────────

  describe("endpoints.send", () => {
    it("POST with JSON body", async () => {
      const ep = await client.endpoints.create({ name: "Send POST" });
      createdSlugs.push(ep.slug);

      const res = await client.endpoints.send(ep.slug, {
        method: "POST",
        body: { key: "value", nested: { arr: [1, 2, 3] } },
      });
      expect(res.ok).toBe(true);

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    });

    it("GET request (no body)", async () => {
      const ep = await client.endpoints.create({ name: "Send GET" });
      createdSlugs.push(ep.slug);

      const res = await client.endpoints.send(ep.slug, { method: "GET" });
      expect(res.ok).toBe(true);

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    });

    it("PUT with custom headers", async () => {
      const ep = await client.endpoints.create({ name: "Send PUT" });
      createdSlugs.push(ep.slug);

      const res = await client.endpoints.send(ep.slug, {
        method: "PUT",
        headers: {
          "X-Custom": "live-test",
          "X-Request-Id": "req-123",
        },
        body: { updated: true },
      });
      expect(res.ok).toBe(true);

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    });

    it("PATCH request", async () => {
      const ep = await client.endpoints.create({ name: "Send PATCH" });
      createdSlugs.push(ep.slug);

      const res = await client.endpoints.send(ep.slug, {
        method: "PATCH",
        body: { field: "patched" },
      });
      expect(res.ok).toBe(true);

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    });

    it("DELETE request", async () => {
      const ep = await client.endpoints.create({ name: "Send DELETE" });
      createdSlugs.push(ep.slug);

      const res = await client.endpoints.send(ep.slug, {
        method: "DELETE",
      });
      expect(res.ok).toBe(true);

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    });
  });

  // ── Requests ─────────────────────────────────────────────────────

  describe("requests", () => {
    it("list: returns captured requests", async () => {
      const ep = await client.endpoints.create({ name: "List Requests" });
      createdSlugs.push(ep.slug);

      await client.endpoints.send(ep.slug, {
        method: "POST",
        body: { n: 1 },
      });
      await client.endpoints.send(ep.slug, {
        method: "POST",
        body: { n: 2 },
      });

      // Wait for both to be captured
      await new Promise((r) => setTimeout(r, 3000));

      const requests = await client.requests.list(ep.slug);
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(requests[0].method).toBe("POST");

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    }, 20000);

    it("list: limit parameter", async () => {
      const ep = await client.endpoints.create({ name: "List Limit" });
      createdSlugs.push(ep.slug);

      // Send 3 requests
      for (let i = 0; i < 3; i++) {
        await client.endpoints.send(ep.slug, {
          method: "POST",
          body: { i },
        });
      }

      await new Promise((r) => setTimeout(r, 3000));

      const limited = await client.requests.list(ep.slug, { limit: 1 });
      expect(limited.length).toBe(1);

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    }, 20000);

    it("get: returns full request details", async () => {
      const ep = await client.endpoints.create({ name: "Get Request" });
      createdSlugs.push(ep.slug);

      await client.endpoints.send(ep.slug, {
        method: "POST",
        headers: { "x-detail-test": "yes" },
        body: { detail: true },
      });

      const captured = await client.requests.waitFor(ep.slug, {
        timeout: "20s",
      });

      const full = await client.requests.get(captured.id);
      expect(full.id).toBe(captured.id);
      expect(full.method).toBe("POST");
      expect(full.headers).toBeDefined();
      expect(full.headers["x-detail-test"]).toBe("yes");
      expect(full.body).toContain("detail");
      expect(full.ip).toBeTruthy();
      expect(full.size).toBeGreaterThan(0);
      expect(full.receivedAt).toBeTypeOf("number");

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    }, 15000);

    it("waitFor: with match function", async () => {
      const ep = await client.endpoints.create({ name: "WaitFor Match" });
      createdSlugs.push(ep.slug);

      // Send the target request with a unique marker
      await client.endpoints.send(ep.slug, {
        method: "POST",
        headers: { "x-target": "true" },
        body: { target: true },
      });

      // Wait for it with a generous timeout
      const matched = await client.requests.waitFor(ep.slug, {
        timeout: "30s",
        pollInterval: "500ms",
        match: matchAll(matchMethod("POST"), matchHeader("x-target")),
      });

      expect(matched.method).toBe("POST");
      expect(matched.headers["x-target"]).toBe("true");

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    }, 35000);

    it("waitFor: times out when no match", async () => {
      const ep = await client.endpoints.create({ name: "WaitFor Timeout" });
      createdSlugs.push(ep.slug);

      try {
        await client.requests.waitFor(ep.slug, {
          timeout: "2s",
          pollInterval: "500ms",
          match: matchHeader("x-will-never-exist"),
        });
        expect.fail("Should have thrown TimeoutError");
      } catch (error) {
        expect(error).toBeInstanceOf(TimeoutError);
      }

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    }, 10000);

    it("replay: forwards request to target endpoint", async () => {
      const source = await client.endpoints.create({ name: "Replay Source" });
      const target = await client.endpoints.create({ name: "Replay Target" });
      createdSlugs.push(source.slug, target.slug);

      // Send to source
      await client.endpoints.send(source.slug, {
        method: "POST",
        headers: {
          "x-replay-verify": "live-test",
          "content-type": "application/json",
        },
        body: { action: "replay-me", data: [1, 2, 3] },
      });

      // Wait for capture
      const captured = await client.requests.waitFor(source.slug, {
        timeout: "20s",
        match: matchHeader("x-replay-verify"),
      });

      // Replay to target
      const targetUrl = `${WEBHOOK_URL}/w/${target.slug}`;
      const res = await client.requests.replay(captured.id, targetUrl);
      expect(res.ok).toBe(true);

      // Verify replayed request arrived
      const replayed = await client.requests.waitFor(target.slug, {
        timeout: "20s",
      });
      expect(replayed.method).toBe("POST");
      expect(replayed.headers["x-replay-verify"]).toBe("live-test");
      const body = JSON.parse(replayed.body!);
      expect(body.action).toBe("replay-me");
      expect(body.data).toEqual([1, 2, 3]);

      await client.endpoints.delete(source.slug);
      await client.endpoints.delete(target.slug);
      createdSlugs.splice(createdSlugs.indexOf(source.slug), 1);
      createdSlugs.splice(createdSlugs.indexOf(target.slug), 1);
    }, 30000);
  });

  // ── SSE Subscribe ────────────────────────────────────────────────

  describe("requests.subscribe", () => {
    it("streams incoming requests in real time", async () => {
      const ep = await client.endpoints.create({ name: "SSE Test" });
      createdSlugs.push(ep.slug);

      const received: unknown[] = [];
      const controller = new AbortController();

      // Start subscribing in background
      const subscribePromise = (async () => {
        try {
          for await (const request of client.requests.subscribe(ep.slug, {
            signal: controller.signal,
            timeout: "15s",
          })) {
            received.push(request);
            if (received.length >= 2) {
              controller.abort();
              break;
            }
          }
        } catch (e: unknown) {
          // Abort errors are expected
          const err = e as { name?: string; code?: string };
          if (err?.name !== "AbortError" && err?.code !== "ERR_INVALID_STATE") {
            throw e;
          }
        }
      })();

      // Give SSE connection time to establish
      await new Promise((r) => setTimeout(r, 2000));

      // Send 2 webhooks
      await client.endpoints.send(ep.slug, {
        method: "POST",
        headers: { "x-seq": "1" },
        body: { seq: 1 },
      });

      await new Promise((r) => setTimeout(r, 500));

      await client.endpoints.send(ep.slug, {
        method: "POST",
        headers: { "x-seq": "2" },
        body: { seq: 2 },
      });

      // Wait for subscribe to finish (either 2 received or timeout)
      await subscribePromise.catch(() => {});

      expect(received.length).toBeGreaterThanOrEqual(1);
      expect((received[0] as { method: string }).method).toBe("POST");

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    }, 30000);

    it("aborts cleanly with AbortController", async () => {
      const ep = await client.endpoints.create({ name: "SSE Abort" });
      createdSlugs.push(ep.slug);

      const controller = new AbortController();

      const subscribePromise = (async () => {
        const received: unknown[] = [];
        try {
          for await (const request of client.requests.subscribe(ep.slug, {
            signal: controller.signal,
          })) {
            received.push(request);
          }
        } catch (e: unknown) {
          // Abort errors are expected
          const err = e as { name?: string; code?: string };
          if (err?.name !== "AbortError" && err?.code !== "ERR_INVALID_STATE") {
            throw e;
          }
        }
        return received;
      })();

      // Abort after 2 seconds
      await new Promise((r) => setTimeout(r, 2000));
      controller.abort();

      // Should resolve without throwing
      const result = await subscribePromise;
      expect(Array.isArray(result)).toBe(true);

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    }, 10000);
  });

  // ── Matchers (live) ──────────────────────────────────────────────

  describe("matchers (live)", () => {
    it("matchBodyPath: deep nested JSON matching", async () => {
      const ep = await client.endpoints.create({ name: "Body Path" });
      createdSlugs.push(ep.slug);

      await client.endpoints.send(ep.slug, {
        method: "POST",
        body: {
          order: {
            items: [
              { id: "item-1", price: 10 },
              { id: "item-2", price: 20 },
            ],
            customer: { email: "test@example.com" },
          },
        },
      });

      const req = await client.requests.waitFor(ep.slug, {
        timeout: "20s",
        match: matchBodyPath("order.customer.email", "test@example.com"),
      });
      expect(req.method).toBe("POST");

      // Also test array index access
      expect(matchBodyPath("order.items.0.id", "item-1")(req)).toBe(true);
      expect(matchBodyPath("order.items.1.price", 20)(req)).toBe(true);

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    }, 15000);

    it("matchAny: OR logic on live request", async () => {
      const ep = await client.endpoints.create({ name: "matchAny" });
      createdSlugs.push(ep.slug);

      await client.endpoints.send(ep.slug, {
        method: "PUT",
        body: { action: "update" },
      });

      const req = await client.requests.waitFor(ep.slug, {
        timeout: "20s",
        match: matchAny(matchMethod("GET"), matchMethod("PUT")),
      });
      expect(req.method).toBe("PUT");

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    }, 15000);

    it("matchJsonField: top-level field matching", async () => {
      const ep = await client.endpoints.create({ name: "jsonField" });
      createdSlugs.push(ep.slug);

      await client.endpoints.send(ep.slug, {
        method: "POST",
        body: { event_type: "invoice.paid", amount: 1500 },
      });

      const req = await client.requests.waitFor(ep.slug, {
        timeout: "20s",
        match: matchJsonField("event_type", "invoice.paid"),
      });
      const body = JSON.parse(req.body!);
      expect(body.amount).toBe(1500);

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    }, 15000);
  });

  // ── Helpers (live) ───────────────────────────────────────────────

  describe("helpers (live)", () => {
    it("parseJsonBody: parses captured request body", async () => {
      const ep = await client.endpoints.create({ name: "parseBody" });
      createdSlugs.push(ep.slug);

      await client.endpoints.send(ep.slug, {
        method: "POST",
        body: { nested: { deep: { value: 42 } } },
      });

      const req = await client.requests.waitFor(ep.slug, {
        timeout: "20s",
      });

      const parsed = parseJsonBody(req);
      expect(parsed).toEqual({ nested: { deep: { value: 42 } } });

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    }, 15000);

    it("provider detection: all 7 providers", async () => {
      const ep = await client.endpoints.create({ name: "Providers" });
      createdSlugs.push(ep.slug);

      const providers = [
        { header: "stripe-signature", check: isStripeWebhook },
        { header: "x-github-event", check: isGitHubWebhook },
        { header: "x-shopify-hmac-sha256", check: isShopifyWebhook },
        { header: "x-slack-signature", check: isSlackWebhook },
        { header: "x-twilio-signature", check: isTwilioWebhook },
        { header: "paddle-signature", check: isPaddleWebhook },
        { header: "linear-signature", check: isLinearWebhook },
      ];

      for (const { header } of providers) {
        await client.endpoints.send(ep.slug, {
          method: "POST",
          headers: { [header]: "test-value", "x-provider-name": header },
          body: { provider: header },
        });
      }

      // Wait for all to arrive
      await new Promise((r) => setTimeout(r, 4000));
      const requests = await client.requests.list(ep.slug);

      for (const { header, check } of providers) {
        const req = requests.find((r) => r.headers["x-provider-name"] === header);
        if (req) {
          expect(check(req)).toBe(true);
          // Verify other providers don't match
          const otherChecks = providers.filter((p) => p.header !== header);
          for (const other of otherChecks) {
            expect(other.check(req)).toBe(false);
          }
        }
      }

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    }, 30000);
  });

  // ── Describe ─────────────────────────────────────────────────────

  describe("describe", () => {
    it("returns complete SDK description", () => {
      const desc = client.describe();

      expect(desc.version).toBe("0.3.0");

      // Endpoint operations
      expect(desc.endpoints.create).toBeDefined();
      expect(desc.endpoints.list).toBeDefined();
      expect(desc.endpoints.get).toBeDefined();
      expect(desc.endpoints.update).toBeDefined();
      expect(desc.endpoints.delete).toBeDefined();
      expect(desc.endpoints.send).toBeDefined();
      expect(Object.keys(desc.endpoints)).toHaveLength(6);

      // Request operations
      expect(desc.requests.list).toBeDefined();
      expect(desc.requests.get).toBeDefined();
      expect(desc.requests.waitFor).toBeDefined();
      expect(desc.requests.subscribe).toBeDefined();
      expect(desc.requests.replay).toBeDefined();
      expect(Object.keys(desc.requests)).toHaveLength(5);

      // Each operation has description and params
      for (const op of Object.values(desc.endpoints)) {
        expect(op.description).toBeTypeOf("string");
        expect(op.params).toBeDefined();
      }
      for (const op of Object.values(desc.requests)) {
        expect(op.description).toBeTypeOf("string");
        expect(op.params).toBeDefined();
      }
    });
  });

  // ── Error handling ───────────────────────────────────────────────

  describe("error handling", () => {
    it("UnauthorizedError on invalid API key", async () => {
      const bad = new WebhooksCC({
        apiKey: "whcc_invalid",
        baseUrl: BASE_URL,
      });
      try {
        await bad.endpoints.list();
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(UnauthorizedError);
        expect((error as UnauthorizedError).statusCode).toBe(401);
      }
    });

    it("error on non-existent request ID", async () => {
      try {
        await client.requests.get("nonexistent-request-id");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WebhooksCCError);
        expect((error as WebhooksCCError).statusCode).toBeGreaterThanOrEqual(400);
      }
    });

    it("validates slug format (path traversal protection)", async () => {
      await expect(
        client.endpoints.get("../../../etc/passwd")
      ).rejects.toThrow();
    });

    it("validates mock response status range", async () => {
      const ep = await client.endpoints.create({ name: "Bad Mock" });
      createdSlugs.push(ep.slug);

      await expect(
        client.endpoints.update(ep.slug, {
          mockResponse: { status: 999, body: "", headers: {} },
        })
      ).rejects.toThrow();

      await client.endpoints.delete(ep.slug);
      createdSlugs.pop();
    });
  });

  // ── Lifecycle hooks ──────────────────────────────────────────────

  describe("lifecycle hooks", () => {
    it("onRequest and onResponse are called", async () => {
      const hookLog: string[] = [];

      const hookedClient = new WebhooksCC({
        apiKey: API_KEY!,
        baseUrl: BASE_URL,
        webhookUrl: WEBHOOK_URL,
        hooks: {
          onRequest: (info) => {
            hookLog.push(`request:${info.method}:${info.url}`);
          },
          onResponse: (info) => {
            hookLog.push(`response:${info.status}:${info.durationMs}ms`);
          },
        },
      });

      const ep = await hookedClient.endpoints.create({ name: "Hooks Test" });
      createdSlugs.push(ep.slug);

      await hookedClient.endpoints.list();
      await hookedClient.endpoints.delete(ep.slug);
      createdSlugs.pop();

      // Should have logged multiple request/response pairs
      expect(hookLog.some((l) => l.startsWith("request:"))).toBe(true);
      expect(hookLog.some((l) => l.startsWith("response:"))).toBe(true);
      expect(hookLog.filter((l) => l.startsWith("request:")).length).toBeGreaterThanOrEqual(3);
    });

    it("onError is called on failure", async () => {
      let errorCaught = false;

      const hookedClient = new WebhooksCC({
        apiKey: "whcc_bad_key",
        baseUrl: BASE_URL,
        hooks: {
          onError: (info) => {
            errorCaught = true;
            expect(info.error).toBeInstanceOf(Error);
            expect(info.durationMs).toBeTypeOf("number");
          },
        },
      });

      try {
        await hookedClient.endpoints.list();
      } catch {
        // Expected
      }

      expect(errorCaught).toBe(true);
    });
  });
});
