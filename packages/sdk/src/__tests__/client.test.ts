import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebhooksCC } from "../client";
import { WebhooksCCError, UnauthorizedError, NotFoundError } from "../errors";
import { TEMPLATE_METADATA } from "../index";

const API_KEY = "whcc_testkey123";
const BASE_URL = "https://test.webhooks.cc";
const WEBHOOK_URL = "https://go.test.webhooks.cc";

function createClient(opts?: {
  timeout?: number;
  webhookUrl?: string;
  retry?: {
    maxAttempts?: number;
    backoffMs?: number;
    retryOn?: number[];
  };
}) {
  return new WebhooksCC({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    webhookUrl: WEBHOOK_URL,
    ...opts,
  });
}

async function hmacSha1Base64(secret: string, payload: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("crypto.subtle is required for this test");
  }
  const key = await subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Buffer.from(new Uint8Array(signature)).toString("base64");
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

function mockSSEStream(...frames: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });

  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body,
    text: () => Promise.resolve(frames.join("")),
  };
}

describe("WebhooksCC", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("endpoints.create", () => {
    it("sends POST /api/endpoints with auth header", async () => {
      const endpoint = {
        id: "ep1",
        slug: "abc123",
        url: "https://r.webhooks.cc/w/abc123",
        createdAt: Date.now(),
      };
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
      const endpoint = {
        id: "ep1",
        slug: "abc123",
        url: "https://r.webhooks.cc/w/abc123",
        createdAt: Date.now(),
      };
      const fetchMock = mockFetch({ body: endpoint });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.endpoints.create();

      const [, opts] = fetchMock.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual({});
    });

    it("maps ephemeral create options to API fields", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

      const endpoint = {
        id: "ep1",
        slug: "abc123",
        url: "https://r.webhooks.cc/w/abc123",
        isEphemeral: true,
        expiresAt: Date.now() + 3600000,
        createdAt: Date.now(),
      };
      const fetchMock = mockFetch({ body: endpoint });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.endpoints.create({
        name: "Temp",
        ephemeral: false,
        expiresIn: "1h",
        mockResponse: { status: 202, body: "queued", headers: { "x-mock": "true" } },
      });

      const [, opts] = fetchMock.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual({
        name: "Temp",
        isEphemeral: true,
        expiresAt: Date.now() + 3600000,
        mockResponse: { status: 202, body: "queued", headers: { "x-mock": "true" } },
      });
    });
  });

  describe("endpoints.list", () => {
    it("sends GET /api/endpoints and flattens owned + shared", async () => {
      const owned = [
        { id: "ep1", slug: "abc", url: "https://r.webhooks.cc/w/abc", createdAt: Date.now() },
      ];
      const shared = [
        {
          id: "ep2",
          slug: "def",
          url: "https://r.webhooks.cc/w/def",
          createdAt: Date.now(),
          fromTeam: { teamId: "t1", teamName: "Team A" },
        },
      ];
      const fetchMock = mockFetch({ body: { owned, shared } });
      globalThis.fetch = fetchMock;

      const client = createClient();
      const result = await client.endpoints.list();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("ep1");
      expect(result[1].id).toBe("ep2");
      expect(result[1].fromTeam).toEqual({ teamId: "t1", teamName: "Team A" });
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/endpoints`);
      expect(opts.method).toBe("GET");
    });

    it("returns empty array when no endpoints", async () => {
      const fetchMock = mockFetch({ body: { owned: [], shared: [] } });
      globalThis.fetch = fetchMock;

      const client = createClient();
      const result = await client.endpoints.list();

      expect(result).toEqual([]);
    });
  });

  describe("templates", () => {
    it("lists supported template providers in a stable order", () => {
      const providers = createClient().templates.listProviders();

      expect(providers).toEqual([
        "stripe",
        "github",
        "shopify",
        "twilio",
        "slack",
        "paddle",
        "linear",
        "sendgrid",
        "clerk",
        "discord",
        "vercel",
        "gitlab",
        "standard-webhooks",
      ]);
    });

    it("returns static provider metadata", () => {
      const info = createClient().templates.get("stripe");

      expect(info).toEqual({
        provider: "stripe",
        templates: ["payment_intent.succeeded", "checkout.session.completed", "invoice.paid"],
        defaultTemplate: "payment_intent.succeeded",
        secretRequired: true,
        signatureHeader: "stripe-signature",
        signatureAlgorithm: "hmac-sha256",
      });
      expect(TEMPLATE_METADATA["slack"]).toEqual({
        provider: "slack",
        templates: ["event_callback", "slash_command", "url_verification"],
        defaultTemplate: "event_callback",
        secretRequired: true,
        signatureHeader: "x-slack-signature",
        signatureAlgorithm: "hmac-sha256",
      });
      expect(TEMPLATE_METADATA["standard-webhooks"]).toEqual({
        provider: "standard-webhooks",
        templates: [],
        secretRequired: true,
        signatureHeader: "webhook-signature",
        signatureAlgorithm: "hmac-sha256",
      });
    });
  });

  describe("endpoints.sendTemplate", () => {
    it("sends a Stripe template webhook with signed stripe-signature header", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.endpoints.sendTemplate("abc123", {
        provider: "stripe",
        secret: "whsec_test_123",
        timestamp: 1700000000,
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${WEBHOOK_URL}/w/abc123`);
      expect(opts.method).toBe("POST");
      expect(opts.headers["content-type"] ?? opts.headers["Content-Type"]).toContain(
        "application/json"
      );
      expect(opts.headers["stripe-signature"]).toMatch(/^t=1700000000,v1=[a-f0-9]+$/);
      expect(opts.headers["x-webhooks-cc-template-template"]).toBe("payment_intent.succeeded");
      expect(opts.body).toContain('"type":"payment_intent.succeeded"');
    });

    it("sends a GitHub pull_request template webhook with signature and event headers", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.endpoints.sendTemplate("abc123", {
        provider: "github",
        template: "pull_request.opened",
        secret: "github_secret",
      });

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["x-github-event"]).toBe("pull_request");
      expect(opts.headers["x-hub-signature-256"]).toMatch(/^sha256=[a-f0-9]+$/);
      expect(opts.headers["x-github-delivery"]).toBeTruthy();
      expect(opts.body).toContain('"action":"opened"');
      expect(opts.body).toContain('"pull_request"');
    });

    it("sends a Shopify template with topic and HMAC headers", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.endpoints.sendTemplate("abc123", {
        provider: "shopify",
        template: "products/update",
        secret: "shopify_secret",
      });

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["x-shopify-topic"]).toBe("products/update");
      expect(opts.headers["x-shopify-hmac-sha256"]).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(opts.headers["x-shopify-shop-domain"]).toBeTruthy();
      expect(opts.body).toContain('"title":"Webhook Tester Hoodie"');
    });

    it("sends a Twilio template webhook as form-encoded body", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.endpoints.sendTemplate("abc123", {
        provider: "twilio",
        template: "messaging.status_callback",
        secret: "twilio_auth_token",
      });

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["content-type"] ?? opts.headers["Content-Type"]).toContain(
        "application/x-www-form-urlencoded"
      );
      expect(opts.headers["x-twilio-signature"]).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(opts.body).toContain("MessageSid=");
      expect(opts.body).toContain("MessageStatus=delivered");
    });

    it("sends a Slack template webhook with signed headers", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      await createClient().endpoints.sendTemplate("abc123", {
        provider: "slack",
        secret: "slack_secret",
        template: "slash_command",
        timestamp: 1700000000,
      });

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["x-slack-request-timestamp"]).toBe("1700000000");
      expect(opts.headers["x-slack-signature"]).toMatch(/^v0=[a-f0-9]+$/);
      expect(opts.body).toContain("command=%2Fwebhook-test");
    });

    it("sends a Paddle template webhook with paddle-signature", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      await createClient().endpoints.sendTemplate("abc123", {
        provider: "paddle",
        secret: "paddle_secret",
        timestamp: 1700000000,
      });

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["paddle-signature"]).toMatch(/^ts=1700000000;h1=[a-f0-9]+$/);
      expect(opts.body).toContain('"event_type":"transaction.completed"');
    });

    it("sends a Linear template webhook with linear-signature", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      await createClient().endpoints.sendTemplate("abc123", {
        provider: "linear",
        secret: "linear_secret",
        template: "issue.update",
      });

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["linear-signature"]).toMatch(/^sha256=[a-f0-9]+$/);
      expect(opts.body).toContain('"type":"Issue"');
      expect(opts.body).toContain('"action":"update"');
    });

    it("signs Twilio string body override using URL + sorted params", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      const bodyOverride =
        "MessageStatus=delivered&To=%2B14155559876&From=%2B14155550123&MessageSid=SM123";
      const client = createClient();
      await client.endpoints.sendTemplate("abc123", {
        provider: "twilio",
        secret: "twilio_auth_token",
        body: bodyOverride,
      });

      const [, opts] = fetchMock.mock.calls[0];
      const endpointUrl = `${WEBHOOK_URL}/w/abc123`;
      const sorted = Array.from(new URLSearchParams(bodyOverride).entries()).sort(([a], [b]) =>
        a.localeCompare(b)
      );
      const signaturePayload = `${endpointUrl}${sorted.map(([k, v]) => `${k}${v}`).join("")}`;
      const expectedSignature = await hmacSha1Base64("twilio_auth_token", signaturePayload);

      expect(opts.body).toBe(bodyOverride);
      expect(opts.headers["x-twilio-signature"]).toBe(expectedSignature);
    });

    it("throws on unsupported provider template", async () => {
      const client = createClient();
      await expect(
        client.endpoints.sendTemplate("abc123", {
          provider: "stripe",
          template: "not-a-template",
          secret: "whsec_test_123",
        })
      ).rejects.toThrow(/Unsupported template/i);
    });

    it("throws when secret is missing", async () => {
      const client = createClient();
      await expect(
        client.endpoints.sendTemplate("abc123", {
          provider: "stripe",
          secret: "",
        })
      ).rejects.toThrow(/non-empty secret/i);
    });

    it("sends a Standard Webhooks template with webhook-id, webhook-timestamp, webhook-signature headers", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      // base64-encode a test secret
      const rawSecret = "test-secret-bytes";
      const b64Secret = Buffer.from(rawSecret).toString("base64");

      const client = createClient();
      await client.endpoints.sendTemplate("abc123", {
        provider: "standard-webhooks",
        secret: b64Secret,
        body: { type: "subscription.created", data: { id: "sub_123" } },
        timestamp: 1700000000,
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${WEBHOOK_URL}/w/abc123`);
      expect(opts.method).toBe("POST");
      expect(opts.headers["webhook-id"]).toMatch(/^msg_[a-f0-9]+$/);
      expect(opts.headers["webhook-timestamp"]).toBe("1700000000");
      expect(opts.headers["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/=]+$/);
      expect(opts.headers["content-type"]).toBe("application/json");
      expect(opts.body).toContain('"type":"subscription.created"');
    });

    it("strips whsec_ prefix from Standard Webhooks secret", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      const rawSecret = "test-secret-bytes";
      const b64Secret = Buffer.from(rawSecret).toString("base64");

      const client = createClient();

      // Send with whsec_ prefix
      await client.endpoints.sendTemplate("abc123", {
        provider: "standard-webhooks",
        secret: `whsec_${b64Secret}`,
        body: { test: true },
        timestamp: 1700000000,
      });

      const [, optsWithPrefix] = fetchMock.mock.calls[0];

      // Send without prefix (same base64 secret)
      await client.endpoints.sendTemplate("abc123", {
        provider: "standard-webhooks",
        secret: b64Secret,
        body: { test: true },
        timestamp: 1700000000,
      });

      const [, optsWithout] = fetchMock.mock.calls[1];

      // Both should produce signatures with the same format (content differs due to random msgId)
      expect(optsWithPrefix.headers["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/=]+$/);
      expect(optsWithout.headers["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/=]+$/);
    });

    it("verifies Standard Webhooks signature is correct", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      const rawSecretBytes = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      ]);
      const b64Secret = Buffer.from(rawSecretBytes).toString("base64");
      const body = { type: "test.event" };
      const bodyStr = JSON.stringify(body);

      const client = createClient();
      await client.endpoints.sendTemplate("abc123", {
        provider: "standard-webhooks",
        secret: b64Secret,
        body,
        timestamp: 1700000000,
      });

      const [, opts] = fetchMock.mock.calls[0];
      const msgId = opts.headers["webhook-id"];
      const timestamp = opts.headers["webhook-timestamp"];
      const sigHeader = opts.headers["webhook-signature"];

      // Verify signature manually
      const signingInput = `${msgId}.${timestamp}.${bodyStr}`;
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        rawSecretBytes.buffer as ArrayBuffer,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const expectedSig = await globalThis.crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(signingInput)
      );
      const expectedB64 = Buffer.from(new Uint8Array(expectedSig)).toString("base64");

      expect(sigHeader).toBe(`v1,${expectedB64}`);
    });

    it("includes event prefix in Standard Webhooks message ID when event provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      const b64Secret = Buffer.from("secret").toString("base64");
      const client = createClient();
      await client.endpoints.sendTemplate("abc123", {
        provider: "standard-webhooks",
        secret: b64Secret,
        event: "subscription.created",
        body: { type: "subscription.created" },
      });

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["webhook-id"]).toMatch(/^msg_subscription\.created_[a-f0-9]+$/);
    });

    it("Standard Webhooks works without body override (defaults to empty object)", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      const b64Secret = Buffer.from("secret").toString("base64");
      const client = createClient();
      await client.endpoints.sendTemplate("abc123", {
        provider: "standard-webhooks",
        secret: b64Secret,
      });

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.body).toBe("{}");
      expect(opts.headers["webhook-id"]).toBeTruthy();
      expect(opts.headers["webhook-timestamp"]).toBeTruthy();
      expect(opts.headers["webhook-signature"]).toMatch(/^v1,/);
    });
  });

  describe("endpoints.get", () => {
    it("sends GET /api/endpoints/{slug}", async () => {
      const endpoint = {
        id: "ep1",
        slug: "abc123",
        url: "https://r.webhooks.cc/w/abc123",
        createdAt: Date.now(),
      };
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
      const fetchMock = mockFetch({
        status: 204,
        body: undefined,
        headers: { "content-length": "0" },
      });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.endpoints.delete("abc123");

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/endpoints/abc123`);
      expect(opts.method).toBe("DELETE");
    });
  });

  describe("sendTo", () => {
    it("sends a plain POST to an arbitrary URL", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.sendTo("http://localhost:3000/webhooks", {
        body: { event: "test" },
      });

      // First call is to the target URL (not the API)
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("http://localhost:3000/webhooks");
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(opts.body)).toEqual({ event: "test" });
    });

    it("sends with Standard Webhooks signing to an arbitrary URL", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      const b64Secret = Buffer.from("test-secret").toString("base64");
      const client = createClient();
      await client.sendTo("http://localhost:3000/api/webhooks/polar", {
        provider: "standard-webhooks",
        secret: b64Secret,
        body: { type: "subscription.created", data: { id: "sub_123" } },
      });

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("http://localhost:3000/api/webhooks/polar");
      expect(opts.method).toBe("POST");
      expect(opts.headers["webhook-id"]).toBeTruthy();
      expect(opts.headers["webhook-timestamp"]).toBeTruthy();
      expect(opts.headers["webhook-signature"]).toMatch(/^v1,/);
      expect(opts.headers["content-type"]).toBe("application/json");
    });

    it("sends with Stripe signing to an arbitrary URL", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.sendTo("http://localhost:3000/webhooks/stripe", {
        provider: "stripe",
        secret: "whsec_test",
        timestamp: 1700000000,
      });

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("http://localhost:3000/webhooks/stripe");
      expect(opts.headers["stripe-signature"]).toMatch(/^t=1700000000,v1=/);
    });

    it("sends without body or signing", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.sendTo("http://localhost:3000/health", { method: "GET" });

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("http://localhost:3000/health");
      expect(opts.method).toBe("GET");
      expect(opts.body).toBeUndefined();
    });

    it("merges custom headers", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("ok"),
      });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.sendTo("http://localhost:3000/webhooks", {
        headers: { "x-custom": "value" },
        body: { test: true },
      });

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers["x-custom"]).toBe("value");
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("rejects invalid URLs", async () => {
      const client = createClient();
      await expect(client.sendTo("not-a-url")).rejects.toThrow(/not a valid URL/);
    });

    it("rejects non-http protocols", async () => {
      const client = createClient();
      await expect(client.sendTo("ftp://example.com/file")).rejects.toThrow(/only http and https/);
    });

    it("throws when provider set without secret", async () => {
      const client = createClient();
      await expect(
        client.sendTo("http://localhost:3000/webhooks", {
          provider: "standard-webhooks",
        })
      ).rejects.toThrow(/non-empty secret/);
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

  describe("usage", () => {
    it("sends GET /api/usage", async () => {
      const usage = {
        used: 42,
        limit: 50,
        remaining: 8,
        plan: "free" as const,
        periodEnd: 1710460800000,
      };
      const fetchMock = mockFetch({ body: usage });
      globalThis.fetch = fetchMock;

      const client = createClient();
      const result = await client.usage();

      expect(result).toEqual(usage);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/usage`);
      expect(opts.method).toBe("GET");
    });
  });

  describe("requests.listPaginated", () => {
    it("sends GET /api/endpoints/{slug}/requests/paginated with cursor params", async () => {
      const page = {
        items: [{ id: "r1", method: "POST", receivedAt: Date.now() }],
        cursor: "cursor-1",
        hasMore: true,
      };
      const fetchMock = mockFetch({ body: page });
      globalThis.fetch = fetchMock;

      const client = createClient();
      const result = await client.requests.listPaginated("abc123", {
        limit: 10,
        cursor: "cursor-0",
      });

      expect(result).toEqual(page);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(
        `${BASE_URL}/api/endpoints/abc123/requests/paginated?limit=10&cursor=cursor-0`
      );
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

  describe("requests.waitForAll", () => {
    it("collects multiple matching requests in chronological order", async () => {
      const req1 = { id: "r1", method: "POST", receivedAt: 1000 };
      const req2 = { id: "r2", method: "POST", receivedAt: 1001 };

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        const body = callCount === 1 ? [] : [req2, req1];
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(JSON.stringify(body)),
        });
      });

      const result = await createClient().requests.waitForAll("abc123", {
        count: 2,
        timeout: 5000,
        pollInterval: 10,
        match: (request) => request.method === "POST",
      });

      expect(result.map((request) => request.id)).toEqual(["r1", "r2"]);
    });
  });

  describe("requests.search", () => {
    it("sends GET /api/search/requests with normalized filters", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

      const results = [
        {
          id: "abc:1741514400000:deadbeef",
          slug: "abc",
          method: "POST",
          path: "/hooks/stripe",
          headers: { "content-type": "application/json" },
          body: '{"type":"payment_intent.succeeded"}',
          queryParams: { test: "1" },
          contentType: "application/json",
          ip: "127.0.0.1",
          size: 42,
          receivedAt: 1741514400000,
        },
      ];
      const fetchMock = mockFetch({ body: results });
      globalThis.fetch = fetchMock;

      const client = createClient();
      const result = await client.requests.search({
        slug: "abc",
        method: "POST",
        q: "payment_intent",
        from: "1h",
        to: "15m",
        limit: 25,
        offset: 5,
        order: "asc",
      });

      expect(result).toEqual(results);

      const [rawUrl, opts] = fetchMock.mock.calls[0];
      const url = new URL(rawUrl);
      expect(url.pathname).toBe("/api/search/requests");
      expect(url.searchParams.get("slug")).toBe("abc");
      expect(url.searchParams.get("method")).toBe("POST");
      expect(url.searchParams.get("q")).toBe("payment_intent");
      expect(url.searchParams.get("from")).toBe(String(Date.now() - 3600000));
      expect(url.searchParams.get("to")).toBe(String(Date.now() - 900000));
      expect(url.searchParams.get("limit")).toBe("25");
      expect(url.searchParams.get("offset")).toBe("5");
      expect(url.searchParams.get("order")).toBe("asc");
      expect(opts.method).toBe("GET");
    });

    it("rejects invalid slug filters", async () => {
      const client = createClient();
      await expect(client.requests.search({ slug: "../admin" })).rejects.toThrow("Invalid slug");
    });
  });

  describe("requests.count", () => {
    it("sends GET /api/search/requests/count and returns count", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

      const fetchMock = mockFetch({ body: { count: 7 } });
      globalThis.fetch = fetchMock;

      const client = createClient();
      const count = await client.requests.count({
        slug: "abc",
        q: "payment_intent",
        from: "7d",
        to: 1741521600000,
        limit: 99,
        offset: 10,
        order: "desc",
      });

      expect(count).toBe(7);

      const [rawUrl, opts] = fetchMock.mock.calls[0];
      const url = new URL(rawUrl);
      expect(url.pathname).toBe("/api/search/requests/count");
      expect(url.searchParams.get("slug")).toBe("abc");
      expect(url.searchParams.get("q")).toBe("payment_intent");
      expect(url.searchParams.get("from")).toBe(String(Date.now() - 604800000));
      expect(url.searchParams.get("to")).toBe("1741521600000");
      expect(url.searchParams.get("limit")).toBeNull();
      expect(url.searchParams.get("offset")).toBeNull();
      expect(url.searchParams.get("order")).toBeNull();
      expect(opts.method).toBe("GET");
    });
  });

  describe("requests.clear", () => {
    it("sends DELETE /api/endpoints/{slug}/requests with normalized before cutoff", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

      const fetchMock = mockFetch({ body: { deleted: 1, complete: true } });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.requests.clear("abc123", { before: "1h" });

      const [rawUrl, opts] = fetchMock.mock.calls[0];
      const url = new URL(rawUrl);
      expect(url.pathname).toBe("/api/endpoints/abc123/requests");
      expect(url.searchParams.get("before")).toBe(String(Date.now() - 3600000));
      expect(opts.method).toBe("DELETE");
    });
  });

  describe("requests.export", () => {
    it("exports captured requests as cURL commands", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            Promise.resolve({
              id: "ep1",
              slug: "abc123",
              url: "https://go.test.webhooks.cc/w/abc123",
              createdAt: Date.now(),
            }),
          text: () =>
            Promise.resolve(
              '{"id":"ep1","slug":"abc123","url":"https://go.test.webhooks.cc/w/abc123","createdAt":0}'
            ),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            Promise.resolve({
              items: [
                {
                  id: "r1",
                  endpointId: "ep1",
                  method: "POST",
                  path: "/webhook",
                  headers: {
                    host: "localhost",
                    "content-type": "application/json",
                    authorization: "Bearer secret",
                    "x-test": "yes",
                  },
                  body: '{"ok":true}',
                  queryParams: { foo: "bar" },
                  contentType: "application/json",
                  ip: "127.0.0.1",
                  size: 11,
                  receivedAt: 1000,
                },
              ],
              hasMore: false,
            }),
          text: () => Promise.resolve("[]"),
        });

      const result = await createClient().requests.export("abc123", { format: "curl" });

      expect(Array.isArray(result)).toBe(true);
      if (!Array.isArray(result)) {
        throw new Error("Expected cURL export");
      }
      expect(result).toHaveLength(1);
      expect(result[0]).toContain("curl -X POST");
      expect(result[0]).toContain('-H "content-type: application/json"');
      expect(result[0]).toContain('-H "x-test: yes"');
      expect(result[0]).not.toContain("authorization");
      expect(result[0]).toContain("https://go.test.webhooks.cc/w/abc123/webhook?foo=bar");
    });

    it("exports captured requests as HAR", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            Promise.resolve({
              id: "ep1",
              slug: "abc123",
              url: "https://go.test.webhooks.cc/w/abc123",
              createdAt: Date.now(),
            }),
          text: () =>
            Promise.resolve(
              '{"id":"ep1","slug":"abc123","url":"https://go.test.webhooks.cc/w/abc123","createdAt":0}'
            ),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            Promise.resolve({
              items: [
                {
                  id: "r1",
                  endpointId: "ep1",
                  method: "POST",
                  path: "/hooks",
                  headers: { "content-type": "application/json" },
                  body: '{"ok":true}',
                  queryParams: {},
                  contentType: "application/json",
                  ip: "127.0.0.1",
                  size: 11,
                  receivedAt: 1000,
                },
              ],
              hasMore: false,
            }),
          text: () => Promise.resolve("[]"),
        });

      const result = await createClient().requests.export("abc123", { format: "har" });

      expect(Array.isArray(result)).toBe(false);
      if (Array.isArray(result)) {
        throw new Error("Expected HAR export");
      }
      expect(result.log.entries).toHaveLength(1);
      expect(result.log.creator.name).toBe("@webhooks-cc/sdk");
      expect(result.log.entries[0].request.url).toBe("https://go.test.webhooks.cc/w/abc123/hooks");
      expect(result.log.entries[0].request.postData?.text).toBe('{"ok":true}');
    });
  });

  describe("describe", () => {
    it("includes flow, export, waitForAll, and retained search operations", () => {
      const description = createClient().describe();

      expect(description.version).toBe("0.6.0");
      expect(description.usage).toBeDefined();
      expect(description.flow).toBeDefined();
      expect(description.templates.listProviders).toBeDefined();
      expect(description.templates.get).toBeDefined();
      expect(Object.keys(description.templates)).toHaveLength(2);
      expect(description.requests.listPaginated).toBeDefined();
      expect(description.requests.waitForAll).toBeDefined();
      expect(description.requests.export).toBeDefined();
      expect(description.requests.search).toBeDefined();
      expect(description.requests.count).toBeDefined();
      expect(description.requests.clear).toBeDefined();
      expect(description.requests.subscribe.params.reconnect).toBe("boolean?");
      expect(Object.keys(description.requests)).toHaveLength(11);
    });
  });

  describe("requests.subscribe", () => {
    it("reconnects from the last received timestamp and deduplicates replayed events", async () => {
      const request1 = {
        _id: "r1",
        endpointId: "ep1",
        method: "POST",
        path: "/hook",
        headers: { "content-type": "application/json" },
        body: '{"step":1}',
        queryParams: {},
        contentType: "application/json",
        ip: "127.0.0.1",
        size: 10,
        receivedAt: 1000,
      };
      const request2 = {
        ...request1,
        _id: "r2",
        body: '{"step":2}',
        receivedAt: 1001,
      };
      const onReconnect = vi.fn();
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockSSEStream(`event: request\ndata: ${JSON.stringify(request1)}\n\n`)
        )
        .mockResolvedValueOnce(
          mockSSEStream(
            `event: request\ndata: ${JSON.stringify(request1)}\n\n`,
            `event: request\ndata: ${JSON.stringify(request2)}\n\n`,
            "event: endpoint_deleted\ndata: {}\n\n"
          )
        );

      const iterator = createClient()
        .requests.subscribe("abc123", {
          reconnect: true,
          maxReconnectAttempts: 2,
          reconnectBackoffMs: 0,
          onReconnect,
        })
        [Symbol.asyncIterator]();

      const first = await iterator.next();
      const second = await iterator.next();
      const done = await iterator.next();

      expect(first.value?.id).toBe("r1");
      expect(second.value?.id).toBe("r2");
      expect(done.done).toBe(true);
      expect(onReconnect).toHaveBeenCalledWith(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        2,
        `${BASE_URL}/api/stream/abc123?since=999`,
        expect.objectContaining({
          headers: { Authorization: `Bearer ${API_KEY}` },
        })
      );
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
      ).rejects.toThrow(/timed out/i);
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
      ).rejects.toBeInstanceOf(UnauthorizedError);
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
      ).rejects.toBeInstanceOf(NotFoundError);
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
    it("throws WebhooksCCError with status code on non-ok response", async () => {
      const fetchMock = mockFetch({ status: 400, body: { error: "bad request" } });
      globalThis.fetch = fetchMock;

      const client = createClient();
      try {
        await client.endpoints.list();
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WebhooksCCError);
        expect((error as WebhooksCCError).statusCode).toBe(400);
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
        expect((error as WebhooksCCError).message.length).toBeLessThan(300);
      }
    });
  });

  describe("retry", () => {
    it("retries configured transient responses with exponential backoff", async () => {
      vi.useFakeTimers();

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({ error: "internal" }),
          text: () => Promise.resolve('{"error":"internal"}'),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve([]),
          text: () => Promise.resolve("[]"),
        });

      const promise = createClient({
        retry: { maxAttempts: 2, backoffMs: 25, retryOn: [500] },
      }).endpoints.list();

      await vi.runAllTimersAsync();

      await expect(promise).resolves.toEqual([]);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("honors Retry-After when retrying 429 responses", async () => {
      vi.useFakeTimers();

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Headers({
            "content-type": "application/json",
            "retry-after": "2",
          }),
          json: () => Promise.resolve({ error: "rate_limited" }),
          text: () => Promise.resolve('{"error":"rate_limited"}'),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            Promise.resolve({
              used: 1,
              limit: 50,
              remaining: 49,
              plan: "free",
              periodEnd: null,
            }),
          text: () =>
            Promise.resolve('{"used":1,"limit":50,"remaining":49,"plan":"free","periodEnd":null}'),
        });

      const promise = createClient({
        retry: { maxAttempts: 2, backoffMs: 10, retryOn: [429] },
      }).usage();

      await Promise.resolve();
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1999);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toMatchObject({ remaining: 49 });
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("does not retry deterministic 4xx responses", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ error: "bad_request" }),
        text: () => Promise.resolve('{"error":"bad_request"}'),
      });

      await expect(
        createClient({
          retry: { maxAttempts: 3, backoffMs: 10, retryOn: [429, 500] },
        }).endpoints.list()
      ).rejects.toBeInstanceOf(WebhooksCCError);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
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
