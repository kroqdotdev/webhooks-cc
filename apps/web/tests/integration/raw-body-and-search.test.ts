/**
 * E2E tests for raw body fidelity (migration 00019) and search scalability
 * (migration 00020 + pg_trgm indexes).
 *
 * Tests the full path: HTTP POST to receiver -> stored in DB -> read via API.
 * Requires both the web app (port 3000) and receiver (port 3001) to be running.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import {
  byteaToBase64,
  getRequestByIdForUser,
  listRequestsForEndpointByUser,
} from "@/lib/supabase/requests";
import { searchRequestsForUser, countSearchRequestsForUser } from "@/lib/supabase/search";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const RECEIVER_URL = "http://localhost:3001";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEST_EMAIL = `test-rawbody-${Date.now()}@webhooks-test.local`;
const TEST_PASSWORD = "TestPassword123!";

let testUserId: string;
let endpointId: string;
let endpointSlug: string;

describe("Raw Body Fidelity & Search", () => {
  beforeAll(async () => {
    // Create test user
    const { data, error } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Raw Body Test User" },
    });
    if (error) throw error;
    testUserId = data.user!.id;

    // Set as pro with generous quota
    await admin
      .from("users")
      .update({
        plan: "pro",
        request_limit: 10000,
        requests_used: 0,
        period_end: new Date(Date.now() + 86400000).toISOString(),
      })
      .eq("id", testUserId);

    // Create test endpoint
    const ep = await createEndpointForUser({ userId: testUserId, name: "Raw Body Test" });
    endpointId = ep.id;
    endpointSlug = ep.slug;
  }, 15000);

  afterAll(async () => {
    // Clean up: delete endpoint (cascades to requests), then user
    await admin.from("endpoints").delete().eq("id", endpointId);
    await admin.from("users").delete().eq("id", testUserId);
    await admin.auth.admin.deleteUser(testUserId);
  }, 15000);

  // =========================================================================
  // SECTION 0: byteaToBase64 handles both PostgREST and Realtime formats
  // =========================================================================

  describe("byteaToBase64", () => {
    it("converts PostgREST hex format (with \\x prefix)", () => {
      // Bytes 0x80, 0x81, 0x82 -> base64 "gIGC"
      expect(byteaToBase64("\\x808182")).toBe("gIGC");
    });

    it("converts Realtime hex format (without \\x prefix)", () => {
      // Same bytes via wal2json: no prefix
      expect(byteaToBase64("808182")).toBe("gIGC");
    });

    it("round-trips correctly", () => {
      const original = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x80, 0xff]);
      const hexWithPrefix = "\\x" + original.toString("hex");
      const hexWithout = original.toString("hex");

      const b64FromPostgrest = byteaToBase64(hexWithPrefix);
      const b64FromRealtime = byteaToBase64(hexWithout);

      expect(b64FromPostgrest).toBe(b64FromRealtime);
      expect(Buffer.from(b64FromPostgrest, "base64")).toEqual(original);
    });
  });

  // =========================================================================
  // SECTION 1: Normal webhook capture still works
  // =========================================================================

  describe("normal webhook capture", () => {
    it("captures a JSON POST and stores body as text", async () => {
      const body = JSON.stringify({ event: "test.created", data: { id: 42 } });
      const resp = await fetch(`${RECEIVER_URL}/w/${endpointSlug}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Custom": "hello" },
        body,
      });

      expect(resp.status).toBe(200);

      // Give the DB a moment to process
      await new Promise((r) => setTimeout(r, 200));

      const requests = (await listRequestsForEndpointByUser({
        userId: testUserId,
        slug: endpointSlug,
        limit: 1,
      }))!;

      expect(requests.length).toBeGreaterThanOrEqual(1);
      const req = requests[0];
      expect(req.method).toBe("POST");
      expect(req.path).toBe("/webhook");
      expect(req.body).toBe(body);
      expect(req.bodyRaw).toBeUndefined(); // UTF-8 body: no raw bytes needed
      expect(req.headers["x-custom"]).toBe("hello");
      expect(req.size).toBe(Buffer.byteLength(body));
    });

    it("captures GET requests without body", async () => {
      const resp = await fetch(`${RECEIVER_URL}/w/${endpointSlug}/health?foo=bar`, {
        method: "GET",
      });
      expect(resp.status).toBe(200);

      await new Promise((r) => setTimeout(r, 200));

      const requests = (await listRequestsForEndpointByUser({
        userId: testUserId,
        slug: endpointSlug,
        limit: 10,
      }))!;

      const getReq = requests.find((r) => r.method === "GET");
      expect(getReq).toBeDefined();
      expect(getReq!.path).toBe("/health");
      // GET requests may have empty string body (receiver stores "" not null)
      expect(!getReq!.body || getReq!.body === "").toBe(true);
      expect(getReq!.bodyRaw).toBeUndefined();
    });

    it("captures form-urlencoded body", async () => {
      const body = "name=test&value=123&special=%E2%9C%93";
      const resp = await fetch(`${RECEIVER_URL}/w/${endpointSlug}/form`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      expect(resp.status).toBe(200);

      await new Promise((r) => setTimeout(r, 200));

      const requests = (await listRequestsForEndpointByUser({
        userId: testUserId,
        slug: endpointSlug,
        limit: 10,
      }))!;

      const formReq = requests.find((r) => r.path === "/form");
      expect(formReq).toBeDefined();
      expect(formReq!.body).toBe(body);
      expect(formReq!.bodyRaw).toBeUndefined(); // valid UTF-8
    });
  });

  // =========================================================================
  // SECTION 2: Non-UTF-8 binary payload -> body_raw is populated
  // =========================================================================

  describe("binary payload fidelity", () => {
    it("stores body_raw for non-UTF-8 binary payloads", async () => {
      // Construct a payload with invalid UTF-8 bytes
      const binaryPayload = Buffer.from([
        0x48,
        0x65,
        0x6c,
        0x6c,
        0x6f, // "Hello"
        0x80,
        0x81,
        0x82, // invalid UTF-8 continuation bytes
        0xff,
        0xfe, // more invalid bytes
        0x57,
        0x6f,
        0x72,
        0x6c,
        0x64, // "World"
      ]);

      const resp = await fetch(`${RECEIVER_URL}/w/${endpointSlug}/binary`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: binaryPayload,
      });
      expect(resp.status).toBe(200);

      await new Promise((r) => setTimeout(r, 300));

      const requests = (await listRequestsForEndpointByUser({
        userId: testUserId,
        slug: endpointSlug,
        limit: 10,
      }))!;

      const binReq = requests.find((r) => r.path === "/binary");
      expect(binReq).toBeDefined();

      // body should be the lossy UTF-8 representation (with replacement chars)
      expect(binReq!.body).toBeDefined();
      expect(binReq!.body).toContain("Hello");
      expect(binReq!.body).toContain("World");
      expect(binReq!.body).toContain("\ufffd"); // replacement character

      // bodyRaw should be the exact original bytes as base64
      expect(binReq!.bodyRaw).toBeDefined();
      const decoded = Buffer.from(binReq!.bodyRaw!, "base64");
      expect(decoded).toEqual(binaryPayload);

      // size should reflect actual byte count, not UTF-8 text length
      expect(binReq!.size).toBe(binaryPayload.length);
    });

    it("does NOT populate body_raw for valid UTF-8 payloads", async () => {
      const utf8Body = "Ünïcödé text with emojis 🎉🚀 and CJK 你好世界";
      const resp = await fetch(`${RECEIVER_URL}/w/${endpointSlug}/unicode`, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: utf8Body,
      });
      expect(resp.status).toBe(200);

      await new Promise((r) => setTimeout(r, 200));

      const requests = (await listRequestsForEndpointByUser({
        userId: testUserId,
        slug: endpointSlug,
        limit: 10,
      }))!;

      const uniReq = requests.find((r) => r.path === "/unicode");
      expect(uniReq).toBeDefined();
      expect(uniReq!.body).toBe(utf8Body);
      expect(uniReq!.bodyRaw).toBeUndefined(); // valid UTF-8, no raw bytes
    });

    it("getRequestByIdForUser returns bodyRaw for binary requests", async () => {
      const binaryPayload = Buffer.from([0x80, 0x81, 0x82, 0xfe, 0xff]);
      const resp = await fetch(`${RECEIVER_URL}/w/${endpointSlug}/binary-get`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: binaryPayload,
      });
      expect(resp.status).toBe(200);

      await new Promise((r) => setTimeout(r, 300));

      const requests = (await listRequestsForEndpointByUser({
        userId: testUserId,
        slug: endpointSlug,
        limit: 50,
      }))!;
      const binReq = requests.find((r) => r.path === "/binary-get");
      expect(binReq).toBeDefined();

      // Fetch the individual request by ID
      const detail = await getRequestByIdForUser(testUserId, binReq!.id);
      expect(detail).not.toBeNull();
      expect(detail!.bodyRaw).toBeDefined();
      const decoded = Buffer.from(detail!.bodyRaw!, "base64");
      expect(decoded).toEqual(binaryPayload);
    });
  });

  // =========================================================================
  // SECTION 3: Search still works (and uses trigram indexes)
  // =========================================================================

  describe("search functionality", () => {
    let searchEndpointId: string;
    let searchEndpointSlug: string;

    beforeAll(async () => {
      // Create a separate endpoint with known searchable content
      const ep = await createEndpointForUser({ userId: testUserId, name: "Search Test" });
      searchEndpointId = ep.id;
      searchEndpointSlug = ep.slug;

      // Insert requests with diverse content for search testing
      const now = Date.now();
      const requests = [
        {
          path: "/api/stripe/webhook",
          method: "POST",
          body: '{"type":"payment_intent.succeeded","amount":4200}',
          receivedAt: now - 5000,
        },
        {
          path: "/api/github/push",
          method: "POST",
          body: '{"action":"push","ref":"refs/heads/main"}',
          receivedAt: now - 4000,
        },
        {
          path: "/api/slack/event",
          method: "POST",
          body: '{"type":"message","text":"hello world"}',
          receivedAt: now - 3000,
        },
        {
          path: "/webhooks/shopify/order",
          method: "POST",
          body: '{"topic":"orders/create","shop_domain":"test.myshopify.com"}',
          receivedAt: now - 2000,
        },
        { path: "/health", method: "GET", body: null, receivedAt: now - 1000 },
      ];

      for (const req of requests) {
        await admin.from("requests").insert({
          endpoint_id: searchEndpointId,
          user_id: testUserId,
          method: req.method,
          path: req.path,
          headers: { "content-type": "application/json" },
          body: req.body,
          query_params: {},
          content_type: "application/json",
          ip: "127.0.0.1",
          size: req.body?.length ?? 0,
          received_at: new Date(req.receivedAt).toISOString(),
        });
      }
    }, 10000);

    afterAll(async () => {
      await admin.from("endpoints").delete().eq("id", searchEndpointId);
    });

    it("finds requests by path substring", async () => {
      const results = await searchRequestsForUser({
        userId: testUserId,
        plan: "pro",
        slug: searchEndpointSlug,
        q: "stripe",
      });

      expect(results.length).toBe(1);
      expect(results[0].path).toBe("/api/stripe/webhook");
    });

    it("finds requests by body content", async () => {
      const results = await searchRequestsForUser({
        userId: testUserId,
        plan: "pro",
        slug: searchEndpointSlug,
        q: "payment_intent",
      });

      expect(results.length).toBe(1);
      expect(results[0].body).toContain("payment_intent.succeeded");
    });

    it("finds requests by partial body match", async () => {
      const results = await searchRequestsForUser({
        userId: testUserId,
        plan: "pro",
        slug: searchEndpointSlug,
        q: "myshopify",
      });

      expect(results.length).toBe(1);
      expect(results[0].path).toBe("/webhooks/shopify/order");
    });

    it("search count matches search results", async () => {
      const results = await searchRequestsForUser({
        userId: testUserId,
        plan: "pro",
        slug: searchEndpointSlug,
        q: "/api/",
      });

      const count = await countSearchRequestsForUser({
        userId: testUserId,
        plan: "pro",
        slug: searchEndpointSlug,
        q: "/api/",
      });

      expect(count).toBe(results.length);
      expect(count).toBe(3); // stripe, github, slack paths all contain "/api/"
    });

    it("search with method filter narrows results", async () => {
      const results = await searchRequestsForUser({
        userId: testUserId,
        plan: "pro",
        slug: searchEndpointSlug,
        method: "GET",
      });

      expect(results.length).toBe(1);
      expect(results[0].path).toBe("/health");
    });

    it("search with no matches returns empty array", async () => {
      const results = await searchRequestsForUser({
        userId: testUserId,
        plan: "pro",
        slug: searchEndpointSlug,
        q: "nonexistent_string_xyz123",
      });

      expect(results.length).toBe(0);
    });

    it("search returns results in desc order by default", async () => {
      const results = await searchRequestsForUser({
        userId: testUserId,
        plan: "pro",
        slug: searchEndpointSlug,
      });

      expect(results.length).toBe(5);
      // Most recent first
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].receivedAt).toBeGreaterThanOrEqual(results[i].receivedAt);
      }
    });

    it("search with asc order returns oldest first", async () => {
      const results = await searchRequestsForUser({
        userId: testUserId,
        plan: "pro",
        slug: searchEndpointSlug,
        order: "asc",
      });

      expect(results.length).toBe(5);
      for (let i = 1; i < results.length; i++) {
        expect(results[i].receivedAt).toBeGreaterThanOrEqual(results[i - 1].receivedAt);
      }
    });
  });

  // =========================================================================
  // SECTION 4: Receiver handles edge cases
  // =========================================================================

  describe("receiver edge cases", () => {
    it("returns 404 for nonexistent slug", async () => {
      const resp = await fetch(`${RECEIVER_URL}/w/nonexistent-slug-xyz/test`, {
        method: "POST",
        body: "test",
      });
      expect(resp.status).toBe(404);
    });

    it("captures empty body without error", async () => {
      const resp = await fetch(`${RECEIVER_URL}/w/${endpointSlug}/empty`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(resp.status).toBe(200);

      await new Promise((r) => setTimeout(r, 200));

      const requests = (await listRequestsForEndpointByUser({
        userId: testUserId,
        slug: endpointSlug,
        limit: 20,
      }))!;

      const emptyReq = requests.find((r) => r.path === "/empty");
      expect(emptyReq).toBeDefined();
      expect(emptyReq!.size).toBe(0);
    });

    it("captures large JSON body", async () => {
      const largeBody = JSON.stringify({
        data: Array.from({ length: 1000 }, (_, i) => ({
          id: i,
          name: `item-${i}`,
          value: "x".repeat(100),
        })),
      });

      const resp = await fetch(`${RECEIVER_URL}/w/${endpointSlug}/large`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: largeBody,
      });
      expect(resp.status).toBe(200);

      await new Promise((r) => setTimeout(r, 300));

      const requests = (await listRequestsForEndpointByUser({
        userId: testUserId,
        slug: endpointSlug,
        limit: 20,
      }))!;

      const largeReq = requests.find((r) => r.path === "/large");
      expect(largeReq).toBeDefined();
      expect(largeReq!.body).toBe(largeBody);
      expect(largeReq!.bodyRaw).toBeUndefined(); // valid UTF-8
      expect(largeReq!.size).toBe(Buffer.byteLength(largeBody));
    });
  });
});
