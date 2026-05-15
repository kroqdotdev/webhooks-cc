/**
 * Integration tests for conditional mock response rules.
 *
 * Tests the full path: API create/update with rules -> receiver evaluates
 * rules against incoming webhooks -> correct conditional responses returned.
 *
 * Requires both the web app (port 3000) and receiver (port 3001) to be running,
 * and the database must have migration 00023 applied.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import * as dotenv from "dotenv";
import * as path from "path";

// Also load root .env.local for WHK_API_KEY
dotenv.config({ path: path.resolve(__dirname, "../../../../.env.local") });

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const API_KEY = process.env.WHK_API_KEY ?? "";

const RECEIVER_URL = "http://localhost:3001";
const API_URL = "http://localhost:3000";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEST_EMAIL = `test-rules-${Date.now()}@webhooks-test.local`;
const TEST_PASSWORD = "TestPassword123!";

let testUserId: string;
const createdEndpointSlugs: string[] = [];

/** Helper: create an endpoint with optional rules via API */
async function createEndpoint(body: Record<string, unknown>) {
  const res = await fetch(`${API_URL}/api/endpoints`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.slug) createdEndpointSlugs.push(data.slug);
  return { status: res.status, data };
}

/** Helper: update an endpoint via API */
async function updateEndpoint(slug: string, body: Record<string, unknown>) {
  const res = await fetch(`${API_URL}/api/endpoints/${slug}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

/** Helper: get an endpoint via API */
async function getEndpoint(slug: string) {
  const res = await fetch(`${API_URL}/api/endpoints/${slug}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  return { status: res.status, data: await res.json() };
}

/** Helper: send a webhook to the receiver */
async function sendWebhook(
  slug: string,
  opts: { method?: string; body?: string; headers?: Record<string, string> } = {}
) {
  const res = await fetch(`${RECEIVER_URL}/w/${slug}`, {
    method: opts.method ?? "POST",
    headers: { "Content-Type": "application/json", ...opts.headers },
    body: opts.body,
  });
  return { status: res.status, body: await res.text() };
}

const SAMPLE_RULES = [
  {
    name: "Stripe invoice",
    enabled: true,
    logic: "and",
    conditions: [
      { field: "method", op: "eq", value: "POST" },
      { field: "body_path", op: "eq", path: "type", value: "invoice.paid" },
    ],
    response: {
      status: 201,
      body: '{"matched":"invoice"}',
      headers: { "content-type": "application/json" },
    },
  },
  {
    name: "GET requests",
    enabled: true,
    logic: "and",
    conditions: [{ field: "method", op: "eq", value: "GET" }],
    response: { status: 200, body: "get-matched", headers: {} },
  },
];

const DEFAULT_MOCK = { status: 200, body: "default-fallback", headers: {} };

describe.skipIf(!API_KEY)("Conditional Response Rules", () => {
  beforeAll(async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Rules Test User" },
    });
    if (error) throw error;
    testUserId = data.user!.id;

    await admin
      .from("users")
      .update({
        plan: "pro",
        request_limit: 10000,
        requests_used: 0,
        period_end: new Date(Date.now() + 86400000).toISOString(),
      })
      .eq("id", testUserId);
  });

  afterAll(async () => {
    // Clean up endpoints and requests
    for (const slug of createdEndpointSlugs) {
      const { data: ep } = await admin
        .from("endpoints")
        .select("id")
        .eq("slug", slug)
        .maybeSingle();
      if (ep) {
        await admin.from("requests").delete().eq("endpoint_id", ep.id);
        await admin.from("endpoints").delete().eq("id", ep.id);
      }
    }
    await admin.auth.admin.deleteUser(testUserId);
  });

  // ── API CRUD ──────────────────────────────────────────────────────

  describe("API CRUD", () => {
    let slug: string;

    it("creates endpoint with responseRules", async () => {
      const { status, data } = await createEndpoint({
        name: "rules-crud-test",
        responseRules: SAMPLE_RULES,
        mockResponse: DEFAULT_MOCK,
      });

      expect(status).toBe(200);
      expect(data.responseRules).toBeDefined();
      expect(data.responseRules).toHaveLength(2);
      expect(data.responseRules[0].name).toBe("Stripe invoice");
      expect(data.mockResponse.body).toBe("default-fallback");
      slug = data.slug;
    });

    it("returns responseRules on GET", async () => {
      const { status, data } = await getEndpoint(slug);

      expect(status).toBe(200);
      expect(data.responseRules).toHaveLength(2);
      expect(data.responseRules[1].name).toBe("GET requests");
    });

    it("updates responseRules via PATCH", async () => {
      const newRules = [
        {
          name: "Only rule",
          enabled: true,
          logic: "and",
          conditions: [{ field: "method", op: "eq", value: "DELETE" }],
          response: { status: 204, body: "", headers: {} },
        },
      ];

      const { status, data } = await updateEndpoint(slug, { responseRules: newRules });
      expect(status).toBe(200);
      expect(data.responseRules).toHaveLength(1);
      expect(data.responseRules[0].name).toBe("Only rule");
    });

    it("clears responseRules with null", async () => {
      const { status, data } = await updateEndpoint(slug, { responseRules: null });
      expect(status).toBe(200);
      expect(data.responseRules).toBeUndefined();
    });

    it("preserves responseRules when not included in PATCH", async () => {
      // First set rules
      await updateEndpoint(slug, { responseRules: SAMPLE_RULES });
      // Then update name only
      const { data } = await updateEndpoint(slug, { name: "renamed" });
      expect(data.name).toBe("renamed");
      expect(data.responseRules).toHaveLength(2);
    });
  });

  // ── API Validation ────────────────────────────────────────────────

  describe("API Validation", () => {
    it("rejects non-array responseRules", async () => {
      const { status, data } = await createEndpoint({
        name: "bad-rules",
        responseRules: "not an array",
      });
      expect(status).toBe(400);
      expect(data.error).toContain("array");
    });

    it("rejects rule with empty conditions", async () => {
      const { status, data } = await createEndpoint({
        name: "empty-conds",
        responseRules: [
          {
            conditions: [],
            response: { status: 200, body: "", headers: {} },
          },
        ],
      });
      expect(status).toBe(400);
      expect(data.error).toContain("conditions");
    });

    it("rejects condition with invalid field", async () => {
      const { status, data } = await createEndpoint({
        name: "bad-field",
        responseRules: [
          {
            conditions: [{ field: "invalid_field", op: "eq", value: "x" }],
            response: { status: 200, body: "", headers: {} },
          },
        ],
      });
      expect(status).toBe(400);
      expect(data.error).toContain("field");
    });

    it("rejects condition with invalid op", async () => {
      const { status, data } = await createEndpoint({
        name: "bad-op",
        responseRules: [
          {
            conditions: [{ field: "method", op: "regex", value: ".*" }],
            response: { status: 200, body: "", headers: {} },
          },
        ],
      });
      expect(status).toBe(400);
      expect(data.error).toContain("op");
    });
  });

  // ── Receiver Rule Evaluation ──────────────────────────────────────

  describe("Receiver rule evaluation", () => {
    let slug: string;

    beforeAll(async () => {
      const { data } = await createEndpoint({
        name: "receiver-rules-test",
        responseRules: [
          {
            name: "Invoice paid",
            enabled: true,
            logic: "and",
            conditions: [
              { field: "method", op: "eq", value: "POST" },
              { field: "body_path", op: "eq", path: "type", value: "invoice.paid" },
            ],
            response: {
              status: 201,
              body: '{"matched":"invoice"}',
              headers: { "content-type": "application/json" },
            },
          },
          {
            name: "Checkout completed",
            enabled: true,
            logic: "and",
            conditions: [
              { field: "body_path", op: "eq", path: "type", value: "checkout.completed" },
            ],
            response: {
              status: 202,
              body: '{"matched":"checkout"}',
              headers: { "content-type": "application/json" },
            },
          },
          {
            name: "GET requests",
            enabled: true,
            logic: "and",
            conditions: [{ field: "method", op: "eq", value: "GET" }],
            response: { status: 200, body: "get-rule", headers: {} },
          },
          {
            name: "Header-based (disabled)",
            enabled: false,
            logic: "and",
            conditions: [{ field: "header", op: "exists", name: "x-test" }],
            response: { status: 418, body: "teapot", headers: {} },
          },
          {
            name: "OR logic",
            enabled: true,
            logic: "or",
            conditions: [
              { field: "method", op: "eq", value: "PUT" },
              { field: "method", op: "eq", value: "PATCH" },
            ],
            response: { status: 200, body: "put-or-patch", headers: {} },
          },
        ],
        mockResponse: { status: 200, body: "default-mock", headers: {} },
      });
      slug = data.slug;
    });

    it("matches rule 1: POST + body_path", async () => {
      const res = await sendWebhook(slug, {
        body: JSON.stringify({ type: "invoice.paid" }),
      });
      expect(res.status).toBe(201);
      expect(JSON.parse(res.body)).toEqual({ matched: "invoice" });
    });

    it("matches rule 2: body_path only", async () => {
      const res = await sendWebhook(slug, {
        body: JSON.stringify({ type: "checkout.completed" }),
      });
      expect(res.status).toBe(202);
      expect(JSON.parse(res.body)).toEqual({ matched: "checkout" });
    });

    it("matches GET rule", async () => {
      const res = await sendWebhook(slug, { method: "GET" });
      expect(res.status).toBe(200);
      expect(res.body).toBe("get-rule");
    });

    it("falls back to default when no rule matches", async () => {
      const res = await sendWebhook(slug, {
        body: JSON.stringify({ type: "unknown.event" }),
      });
      expect(res.status).toBe(200);
      expect(res.body).toBe("default-mock");
    });

    it("skips disabled rules", async () => {
      const res = await sendWebhook(slug, {
        body: JSON.stringify({ type: "unknown" }),
        headers: { "x-test": "present" },
      });
      // Should NOT match the disabled header rule (418)
      expect(res.status).toBe(200);
      expect(res.body).toBe("default-mock");
    });

    it("handles OR logic", async () => {
      const putRes = await sendWebhook(slug, { method: "PUT" });
      expect(putRes.body).toBe("put-or-patch");

      const patchRes = await sendWebhook(slug, { method: "PATCH" });
      expect(patchRes.body).toBe("put-or-patch");
    });
  });

  // ── Backward Compatibility ────────────────────────────────────────

  describe("Backward compatibility", () => {
    it("endpoint with only mock response (no rules) works", async () => {
      const { data } = await createEndpoint({
        name: "mock-only",
        mockResponse: { status: 200, body: "just-mock", headers: {} },
      });

      const res = await sendWebhook(data.slug);
      expect(res.status).toBe(200);
      expect(res.body).toBe("just-mock");
    });

    it("endpoint with no mock and no rules returns 200 OK", async () => {
      const { data } = await createEndpoint({ name: "bare-endpoint" });

      const res = await sendWebhook(data.slug);
      expect(res.status).toBe(200);
      expect(res.body).toBe("OK");
    });
  });
});
