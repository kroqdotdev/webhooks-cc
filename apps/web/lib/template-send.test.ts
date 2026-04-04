import { describe, expect, test } from "vitest";

import {
  buildTemplateRequest,
  getTemplatePresets,
  getDefaultTemplateId,
  isSecretRequired,
  type TemplateProvider,
} from "./template-send";

const TARGET_URL = "https://go.webhooks.cc/w/demo";
const SECRET = "mock_webhook_secret";

// ---------------------------------------------------------------------------
// Helper: compute HMAC-SHA1 base64 for Twilio verification
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
describe("template-send error handling", () => {
  test("throws for unsupported template id", async () => {
    await expect(
      buildTemplateRequest({
        provider: "stripe",
        template: "not-a-template",
        secret: SECRET,
        targetUrl: TARGET_URL,
      })
    ).rejects.toThrow("Unsupported template");
  });
});

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
describe("template-send UI helpers", () => {
  test("getTemplatePresets returns presets for all providers with UI presets", () => {
    const providersWithPresets: TemplateProvider[] = [
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
    ];
    for (const provider of providersWithPresets) {
      const presets = getTemplatePresets(provider);
      expect(presets.length).toBeGreaterThan(0);
      for (const preset of presets) {
        expect(preset.id).toBeTruthy();
        expect(preset.label).toBeTruthy();
        expect(preset.event).toBeTruthy();
        expect(["application/json", "application/x-www-form-urlencoded"]).toContain(
          preset.contentType
        );
      }
    }
  });

  test("getDefaultTemplateId returns first preset id", () => {
    expect(getDefaultTemplateId("stripe")).toBe("payment_intent.succeeded");
    expect(getDefaultTemplateId("github")).toBe("push");
    expect(getDefaultTemplateId("standard-webhooks")).toBe("custom");
  });

  test("isSecretRequired reads from SDK metadata", () => {
    expect(isSecretRequired("stripe")).toBe(true);
    expect(isSecretRequired("github")).toBe(true);
    expect(isSecretRequired("sendgrid")).toBe(false);
    expect(isSecretRequired("discord")).toBe(false);
    expect(isSecretRequired("standard-webhooks")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Provider signing coverage — every provider gets a test
// ---------------------------------------------------------------------------
describe("template-send provider signing", () => {
  test("stripe: t=timestamp,v1=hex signature", async () => {
    const req = await buildTemplateRequest({
      provider: "stripe",
      secret: SECRET,
      targetUrl: TARGET_URL,
    });
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["stripe-signature"]).toMatch(/^t=\d+,v1=[a-f0-9]+$/);
    expect(req.body).toContain('"type":"payment_intent.succeeded"');
  });

  test("github: x-hub-signature-256 and x-github-event", async () => {
    const req = await buildTemplateRequest({
      provider: "github",
      secret: SECRET,
      targetUrl: TARGET_URL,
    });
    expect(req.headers["x-hub-signature-256"]).toMatch(/^sha256=[a-f0-9]+$/);
    expect(req.headers["x-github-event"]).toBe("push");
    expect(req.headers["x-github-delivery"]).toBeTruthy();
    expect(req.body).toContain('"ref"');
  });

  test("shopify: x-shopify-hmac-sha256 base64 and x-shopify-topic", async () => {
    const req = await buildTemplateRequest({
      provider: "shopify",
      secret: SECRET,
      targetUrl: TARGET_URL,
    });
    expect(req.headers["x-shopify-hmac-sha256"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(req.headers["x-shopify-topic"]).toBe("orders/create");
  });

  test("twilio: x-twilio-signature base64 with form-encoded body", async () => {
    const req = await buildTemplateRequest({
      provider: "twilio",
      secret: SECRET,
      targetUrl: TARGET_URL,
    });
    expect(req.headers["x-twilio-signature"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(req.body).toContain("MessageSid=");
  });

  test("twilio: signs string body override using URL + sorted params", async () => {
    const bodyOverride =
      "MessageStatus=delivered&To=%2B14155559876&From=%2B14155550123&MessageSid=SM123";
    const req = await buildTemplateRequest({
      provider: "twilio",
      secret: "twilio_auth_token",
      targetUrl: TARGET_URL,
      bodyOverride,
    });

    const sorted = Array.from(new URLSearchParams(bodyOverride).entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const signaturePayload = `${TARGET_URL}${sorted.map(([k, v]) => `${k}${v}`).join("")}`;
    const expectedSignature = await hmacSha1Base64("twilio_auth_token", signaturePayload);

    expect(req.body).toBe(bodyOverride);
    expect(req.headers["x-twilio-signature"]).toBe(expectedSignature);
  });

  test("slack: v0=hex signature with x-slack-request-timestamp", async () => {
    const req = await buildTemplateRequest({
      provider: "slack",
      secret: SECRET,
      targetUrl: TARGET_URL,
    });
    expect(req.headers["x-slack-signature"]).toMatch(/^v0=[a-f0-9]+$/);
    expect(req.headers["x-slack-request-timestamp"]).toMatch(/^\d+$/);
  });

  test("paddle: ts=N;h1=hex signature", async () => {
    const req = await buildTemplateRequest({
      provider: "paddle",
      secret: SECRET,
      targetUrl: TARGET_URL,
    });
    expect(req.headers["paddle-signature"]).toMatch(/^ts=\d+;h1=[a-f0-9]+$/);
  });

  test("linear: sha256=hex signature", async () => {
    const req = await buildTemplateRequest({
      provider: "linear",
      secret: SECRET,
      targetUrl: TARGET_URL,
    });
    expect(req.headers["linear-signature"]).toMatch(/^sha256=[a-f0-9]+$/);
    expect(req.body).toContain('"action"');
  });

  test("sendgrid: no signing, JSON body", async () => {
    const req = await buildTemplateRequest({
      provider: "sendgrid",
      secret: SECRET,
      targetUrl: TARGET_URL,
    });
    expect(req.headers["content-type"]).toBe("application/json");
    // SendGrid has no signature header
    expect(req.headers["sendgrid-signature"]).toBeUndefined();
    expect(req.body).toContain('"event"');
  });

  test("clerk: standard-webhooks signing with svix compatibility", async () => {
    const req = await buildTemplateRequest({
      provider: "clerk",
      secret: "whsec_dGVzdF9zZWNyZXQ=",
      targetUrl: TARGET_URL,
    });
    expect(req.headers["webhook-id"]).toMatch(/^msg_/);
    expect(req.headers["webhook-timestamp"]).toMatch(/^\d+$/);
    expect(req.headers["webhook-signature"]).toMatch(/^v1,/);
    // Svix compatibility headers
    expect(req.headers["svix-id"]).toBe(req.headers["webhook-id"]);
    expect(req.headers["svix-timestamp"]).toBe(req.headers["webhook-timestamp"]);
    expect(req.headers["svix-signature"]).toBe(req.headers["webhook-signature"]);
  });

  test("discord: no signing (Ed25519), JSON body", async () => {
    const req = await buildTemplateRequest({
      provider: "discord",
      secret: SECRET,
      targetUrl: TARGET_URL,
    });
    expect(req.headers["content-type"]).toBe("application/json");
    // Discord uses Ed25519 verification, not HMAC — no signature header from template send
    expect(req.body).toContain('"type"');
  });

  test("vercel: x-vercel-signature hex", async () => {
    const req = await buildTemplateRequest({
      provider: "vercel",
      secret: SECRET,
      targetUrl: TARGET_URL,
    });
    expect(req.headers["x-vercel-signature"]).toMatch(/^[a-f0-9]+$/);
  });

  test("gitlab: x-gitlab-token and x-gitlab-event", async () => {
    const req = await buildTemplateRequest({
      provider: "gitlab",
      secret: SECRET,
      targetUrl: TARGET_URL,
    });
    expect(req.headers["x-gitlab-token"]).toBe(SECRET);
    expect(req.headers["x-gitlab-event"]).toBe("Push Hook");
  });

  test("standard-webhooks: webhook-id/timestamp/signature headers", async () => {
    const req = await buildTemplateRequest({
      provider: "standard-webhooks",
      secret: "whsec_dGVzdF9zZWNyZXQ=",
      targetUrl: TARGET_URL,
    });
    expect(req.method).toBe("POST");
    expect(req.headers["webhook-id"]).toMatch(/^msg_/);
    expect(req.headers["webhook-timestamp"]).toMatch(/^\d+$/);
    expect(req.headers["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect(req.headers["content-type"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// Template selection
// ---------------------------------------------------------------------------
describe("template-send template selection", () => {
  test("selects non-default template by id", async () => {
    const req = await buildTemplateRequest({
      provider: "stripe",
      template: "invoice.paid",
      secret: SECRET,
      targetUrl: TARGET_URL,
    });
    expect(req.body).toContain('"type":"invoice.paid"');
  });

  test("event override changes the event in body", async () => {
    const req = await buildTemplateRequest({
      provider: "github",
      secret: SECRET,
      targetUrl: TARGET_URL,
      event: "custom_event",
    });
    expect(req.headers["x-github-event"]).toBe("custom_event");
  });

  test("body override replaces generated payload", async () => {
    const customBody = { custom: "data", amount: 42 };
    const req = await buildTemplateRequest({
      provider: "stripe",
      secret: SECRET,
      targetUrl: TARGET_URL,
      bodyOverride: customBody,
    });
    expect(JSON.parse(req.body)).toEqual(customBody);
    // Still gets signed
    expect(req.headers["stripe-signature"]).toMatch(/^t=\d+,v1=[a-f0-9]+$/);
  });

  test("gitlab merge_request template uses correct event hook name", async () => {
    const req = await buildTemplateRequest({
      provider: "gitlab",
      template: "merge_request",
      secret: SECRET,
      targetUrl: TARGET_URL,
    });
    expect(req.headers["x-gitlab-event"]).toBe("Merge Request Hook");
  });
});

// ---------------------------------------------------------------------------
// All providers produce valid JSON or form body
// ---------------------------------------------------------------------------
describe("template-send body format", () => {
  const jsonProviders: TemplateProvider[] = [
    "stripe",
    "github",
    "shopify",
    "slack",
    "paddle",
    "linear",
    "sendgrid",
    "clerk",
    "discord",
    "vercel",
    "gitlab",
    "standard-webhooks",
  ];

  for (const provider of jsonProviders) {
    test(`${provider}: body is valid JSON`, async () => {
      const req = await buildTemplateRequest({
        provider,
        secret: "whsec_dGVzdF9zZWNyZXQ=",
        targetUrl: TARGET_URL,
      });
      expect(() => JSON.parse(req.body)).not.toThrow();
    });
  }

  test("twilio: body is valid form-encoded", async () => {
    const req = await buildTemplateRequest({
      provider: "twilio",
      secret: SECRET,
      targetUrl: TARGET_URL,
    });
    expect(() => new URLSearchParams(req.body)).not.toThrow();
    const params = new URLSearchParams(req.body);
    expect(params.has("MessageSid")).toBe(true);
  });
});
