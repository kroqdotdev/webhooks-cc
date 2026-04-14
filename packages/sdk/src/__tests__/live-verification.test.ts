/**
 * Live tests for signature verification via the SDK.
 * Tests the full flow: create endpoint → configure signing → send signed webhook → verify.
 *
 * Requires a running local stack with SIGNING_SECRET_KEY configured.
 * Run with: WHK_API_KEY=whcc_... WHK_BASE_URL=http://localhost:3000 WHK_WEBHOOK_URL=http://localhost:3001 pnpm test -- src/__tests__/live-verification.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "crypto";
import { WebhooksCC } from "../client";
import { matchVerified, matchUnverified } from "../matchers";

const API_KEY = process.env.WHK_API_KEY;
const BASE_URL = process.env.WHK_BASE_URL ?? "https://webhooks.cc";
const WEBHOOK_URL = process.env.WHK_WEBHOOK_URL ?? "https://go.webhooks.cc";

const createdSlugs: string[] = [];

describe.skipIf(!API_KEY)("Live Signature Verification", () => {
  let client: WebhooksCC;
  const TEST_SECRET = "whsec_gK8z2xRvPqN7mT4jL9wYcE5bA1dF6hU3";

  beforeAll(() => {
    client = new WebhooksCC({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      webhookUrl: WEBHOOK_URL,
    });
  });

  afterAll(async () => {
    for (const slug of createdSlugs) {
      try {
        await client.endpoints.delete(slug);
      } catch {
        // Already deleted
      }
    }
  });

  it("configure signing on an endpoint", async () => {
    const ep = await client.endpoints.create({ name: "Sig Verify Test" });
    createdSlugs.push(ep.slug);

    const updated = await client.endpoints.update(ep.slug, {
      signingProvider: "standard-webhooks",
      signingSecret: TEST_SECRET,
    });

    expect(updated.signingProvider).toBe("standard-webhooks");
    expect(updated.hasSigningSecret).toBe(true);
    // Secret itself should never be returned
    expect((updated as unknown as Record<string, unknown>).signingSecret).toBeUndefined();
    expect((updated as unknown as Record<string, unknown>).signingSecretEncrypted).toBeUndefined();
  });

  it("send a correctly signed webhook and verify", async () => {
    const ep = await client.endpoints.create({ name: "Sig Valid Test" });
    createdSlugs.push(ep.slug);

    await client.endpoints.update(ep.slug, {
      signingProvider: "standard-webhooks",
      signingSecret: TEST_SECRET,
    });

    // Build a correctly signed Standard Webhooks request
    const msgId = `msg_test_${Date.now()}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ type: "test.verified", data: { ok: true } });
    const rawSecret = Buffer.from(TEST_SECRET.replace("whsec_", ""), "base64");
    const payload = `${msgId}.${timestamp}.${body}`;
    const sig = createHmac("sha256", rawSecret).update(payload).digest("base64");

    await fetch(`${WEBHOOK_URL}/w/${ep.slug}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": msgId,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${sig}`,
      },
      body,
    });

    // Wait for the verification to complete (fire-and-forget, ~50ms)
    await new Promise((resolve) => setTimeout(resolve, 500));

    const requests = await client.requests.list(ep.slug, { limit: 1 });
    expect(requests.length).toBeGreaterThan(0);

    const req = requests[0];
    expect(req.signatureVerified).toBe(true);
    expect(req.signingProvider).toBe("standard-webhooks");
    expect(req.signatureError).toBeNull();
  });

  it("send a webhook with wrong signature and verify failure", async () => {
    const ep = await client.endpoints.create({ name: "Sig Invalid Test" });
    createdSlugs.push(ep.slug);

    await client.endpoints.update(ep.slug, {
      signingProvider: "standard-webhooks",
      signingSecret: TEST_SECRET,
    });

    // Send with a deliberately wrong signature
    await fetch(`${WEBHOOK_URL}/w/${ep.slug}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": "msg_bad",
        "webhook-timestamp": "1234567890",
        "webhook-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
      body: '{"type":"test.invalid"}',
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const requests = await client.requests.list(ep.slug, { limit: 1 });
    expect(requests.length).toBeGreaterThan(0);

    const req = requests[0];
    expect(req.signatureVerified).toBe(false);
    expect(req.signingProvider).toBe("standard-webhooks");
    expect(req.signatureError).toBeTruthy();

    // Error should be structured JSON with a code field
    const err = JSON.parse(req.signatureError!);
    expect(err.code).toBe("mismatch");
    expect(err.expected).toBeTruthy();
    expect(err.received).toBeTruthy();
  });

  it("matchVerified works with waitFor", async () => {
    const ep = await client.endpoints.create({ name: "Sig Matcher Test" });
    createdSlugs.push(ep.slug);

    await client.endpoints.update(ep.slug, {
      signingProvider: "standard-webhooks",
      signingSecret: TEST_SECRET,
    });

    // Send a correctly signed webhook
    const msgId = `msg_matcher_${Date.now()}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ type: "test.matcher" });
    const rawSecret = Buffer.from(TEST_SECRET.replace("whsec_", ""), "base64");
    const payload = `${msgId}.${timestamp}.${body}`;
    const sig = createHmac("sha256", rawSecret).update(payload).digest("base64");

    // Send in background
    setTimeout(async () => {
      await fetch(`${WEBHOOK_URL}/w/${ep.slug}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "webhook-id": msgId,
          "webhook-timestamp": timestamp,
          "webhook-signature": `v1,${sig}`,
        },
        body,
      });
    }, 200);

    const req = await client.requests.waitFor(ep.slug, {
      match: matchVerified(),
      timeout: "10s",
      pollInterval: "500ms",
    });

    expect(req.signatureVerified).toBe(true);
  });

  it("clear signing config removes verification", async () => {
    const ep = await client.endpoints.create({ name: "Sig Clear Test" });
    createdSlugs.push(ep.slug);

    await client.endpoints.update(ep.slug, {
      signingProvider: "standard-webhooks",
      signingSecret: TEST_SECRET,
    });

    // Clear it
    const cleared = await client.endpoints.update(ep.slug, {
      signingProvider: null,
    });

    expect(cleared.signingProvider).toBeNull();
    expect(cleared.hasSigningSecret).toBe(false);

    // Send a webhook — should have null verification
    await fetch(`${WEBHOOK_URL}/w/${ep.slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"type":"test.no-verify"}',
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const requests = await client.requests.list(ep.slug, { limit: 1 });
    expect(requests[0].signatureVerified).toBeNull();
  });

  it("endpoint types include signing fields", async () => {
    const ep = await client.endpoints.create({ name: "Sig Types Test" });
    createdSlugs.push(ep.slug);

    // Before configuring: null/false
    expect(ep.signingProvider).toBeFalsy();
    expect(ep.hasSigningSecret).toBeFalsy();

    await client.endpoints.update(ep.slug, {
      signingProvider: "github",
      signingSecret: "test_secret_123",
    });

    const fetched = await client.endpoints.get(ep.slug);
    expect(fetched.signingProvider).toBe("github");
    expect(fetched.hasSigningSecret).toBe(true);
    expect(fetched.signingHeader).toBeNull();
  });
});
