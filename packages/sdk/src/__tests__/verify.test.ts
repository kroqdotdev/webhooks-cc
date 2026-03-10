import { describe, expect, it } from "vitest";
import {
  WebhooksCC,
  verifyDiscordSignature,
  verifyGitHubSignature,
  verifyLinearSignature,
  verifyPaddleSignature,
  verifyShopifySignature,
  verifySignature,
  verifySlackSignature,
  verifyStandardWebhookSignature,
  verifyStripeSignature,
  verifyTwilioSignature,
} from "../index";

const client = new WebhooksCC({
  apiKey: "whcc_testkey123",
  baseUrl: "https://test.webhooks.cc",
  webhookUrl: "https://go.test.webhooks.cc",
});

describe("signature verification", () => {
  it("verifies Stripe signatures from raw body and header", async () => {
    const built = await client.buildRequest("https://example.com/webhooks/stripe", {
      provider: "stripe",
      secret: "whsec_test_123",
      body: { id: "evt_123", type: "payment_intent.succeeded" },
      timestamp: 1700000000,
    });

    expect(
      await verifyStripeSignature(built.body, built.headers["stripe-signature"], "whsec_test_123")
    ).toBe(true);
    expect(
      await verifyStripeSignature(built.body, built.headers["stripe-signature"], "wrong_secret")
    ).toBe(false);
  });

  it("verifies GitHub signatures", async () => {
    const built = await client.buildRequest("https://example.com/webhooks/github", {
      provider: "github",
      secret: "github_secret",
      body: { action: "opened", pull_request: { id: 42 } },
    });

    expect(
      await verifyGitHubSignature(built.body, built.headers["x-hub-signature-256"], "github_secret")
    ).toBe(true);
    expect(
      await verifyGitHubSignature(
        `${built.body} `,
        built.headers["x-hub-signature-256"],
        "github_secret"
      )
    ).toBe(false);
  });

  it("verifies Shopify signatures", async () => {
    const built = await client.buildRequest("https://example.com/webhooks/shopify", {
      provider: "shopify",
      secret: "shopify_secret",
      body: { id: 123, topic: "orders/create" },
    });

    expect(
      await verifyShopifySignature(
        built.body,
        built.headers["x-shopify-hmac-sha256"],
        "shopify_secret"
      )
    ).toBe(true);
    expect(await verifyShopifySignature(built.body, "invalid", "shopify_secret")).toBe(false);
  });

  it("verifies Twilio signatures when the signed URL is provided", async () => {
    const url = "https://example.com/webhooks/twilio";
    const built = await client.buildRequest(url, {
      provider: "twilio",
      secret: "twilio_auth_token",
      body: "MessageStatus=delivered&To=%2B14155559876&From=%2B14155550123&MessageSid=SM123",
    });

    expect(
      await verifyTwilioSignature(
        url,
        built.body,
        built.headers["x-twilio-signature"],
        "twilio_auth_token"
      )
    ).toBe(true);

    await expect(
      verifySignature(
        {
          body: built.body,
          headers: { "X-Twilio-Signature": built.headers["x-twilio-signature"] },
        },
        { provider: "twilio", secret: "twilio_auth_token" }
      )
    ).rejects.toThrow("requires options.url");

    await expect(
      verifySignature(
        {
          body: built.body,
          headers: { "X-Twilio-Signature": built.headers["x-twilio-signature"] },
        },
        { provider: "twilio", secret: "twilio_auth_token", url }
      )
    ).resolves.toEqual({ valid: true });
  });

  it("verifies Slack signatures from request headers", async () => {
    const built = await client.buildRequest("https://example.com/webhooks/slack", {
      provider: "slack",
      secret: "slack_signing_secret",
      template: "slash_command",
      timestamp: 1700000000,
    });

    expect(
      await verifySlackSignature(
        built.body,
        {
          "x-slack-signature": built.headers["x-slack-signature"],
          "x-slack-request-timestamp": built.headers["x-slack-request-timestamp"],
        },
        "slack_signing_secret"
      )
    ).toBe(true);

    await expect(
      verifySignature(
        {
          body: built.body,
          headers: {
            "X-Slack-Signature": built.headers["x-slack-signature"],
            "X-Slack-Request-Timestamp": built.headers["x-slack-request-timestamp"],
          },
        },
        { provider: "slack", secret: "slack_signing_secret" }
      )
    ).resolves.toEqual({ valid: true });
  });

  it("verifies Paddle signatures", async () => {
    const built = await client.buildRequest("https://example.com/webhooks/paddle", {
      provider: "paddle",
      secret: "paddle_secret",
      timestamp: 1700000000,
    });

    expect(
      await verifyPaddleSignature(built.body, built.headers["paddle-signature"], "paddle_secret")
    ).toBe(true);
    expect(await verifyPaddleSignature(built.body, "ts=1;h1=invalid", "paddle_secret")).toBe(false);
  });

  it("verifies Linear signatures", async () => {
    const built = await client.buildRequest("https://example.com/webhooks/linear", {
      provider: "linear",
      secret: "linear_secret",
      body: { action: "create", type: "Issue", data: { id: "issue_123" } },
    });

    expect(
      await verifyLinearSignature(built.body, built.headers["linear-signature"], "linear_secret")
    ).toBe(true);

    await expect(
      verifySignature(
        {
          body: built.body,
          headers: { "Linear-Signature": built.headers["linear-signature"] },
        },
        { provider: "linear", secret: "linear_secret" }
      )
    ).resolves.toEqual({ valid: true });
  });

  it("verifies Discord interaction signatures with an Ed25519 public key", async () => {
    const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
    const publicKey = Buffer.from(
      new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))
    ).toString("hex");
    const privateKey = keyPair.privateKey;
    const timestamp = "1700000000";
    const body = '{"type":1}';
    const signature = await crypto.subtle.sign(
      "Ed25519",
      privateKey,
      new TextEncoder().encode(`${timestamp}${body}`)
    );
    const signatureHex = Buffer.from(new Uint8Array(signature)).toString("hex");
    const headers = {
      "x-signature-ed25519": signatureHex,
      "x-signature-timestamp": timestamp,
    };

    expect(await verifyDiscordSignature(body, headers, publicKey)).toBe(true);

    await expect(
      verifySignature(
        {
          body,
          headers: {
            "X-Signature-Ed25519": signatureHex,
            "X-Signature-Timestamp": timestamp,
          },
        },
        { provider: "discord", publicKey }
      )
    ).resolves.toEqual({ valid: true });
  });

  it("verifies Standard Webhooks signatures with whsec_ secrets", async () => {
    const secret = `whsec_${Buffer.from("test-secret-bytes").toString("base64")}`;
    const built = await client.buildRequest("https://example.com/webhooks/standard", {
      provider: "standard-webhooks",
      secret,
      body: { type: "subscription.created", data: { id: "sub_123" } },
      timestamp: 1700000000,
    });

    expect(await verifyStandardWebhookSignature(built.body, built.headers, secret)).toBe(true);

    await expect(
      verifySignature(
        {
          body: built.body,
          headers: {
            "Webhook-Id": built.headers["webhook-id"],
            "Webhook-Timestamp": built.headers["webhook-timestamp"],
            "Webhook-Signature": built.headers["webhook-signature"],
          },
        },
        { provider: "standard-webhooks", secret }
      )
    ).resolves.toEqual({ valid: true });
  });

  it("dispatches provider verification for captured request-like objects", async () => {
    const built = await client.buildRequest("https://example.com/webhooks/stripe", {
      provider: "stripe",
      secret: "whsec_test_123",
      body: { type: "checkout.session.completed" },
      timestamp: 1700000000,
    });

    await expect(
      verifySignature(
        {
          body: built.body,
          headers: { "Stripe-Signature": built.headers["stripe-signature"] },
        },
        { provider: "stripe", secret: "whsec_test_123" }
      )
    ).resolves.toEqual({ valid: true });
  });
});
