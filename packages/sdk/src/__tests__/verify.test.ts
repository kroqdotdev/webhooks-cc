import { describe, expect, it } from "vitest";
import {
  WebhooksCC,
  verifyClerkSignature,
  verifyDiscordSignature,
  verifyGitHubSignature,
  verifyGitLabSignature,
  verifyLinearSignature,
  verifyPaddleSignature,
  verifyShopifySignature,
  verifySignature,
  verifySlackSignature,
  verifyStandardWebhookSignature,
  verifyStripeSignature,
  verifyTypeformSignature,
  verifyTwilioSignature,
  verifyVercelSignature,
  verifyMetaSignature,
  verifyLemonSqueezySignature,
  verifyCoinbaseCommerceSignature,
  verifyRazorpaySignature,
  verifyCalSignature,
  verifyIntercomSignature,
  verifyTelegramSignature,
  verifySquareSignature,
  verifyHubSpotSignature,
  verifyMailgunSignature,
  verifyCalendlySignature,
  verifyMuxSignature,
  verifySentrySignature,
  verifyBitbucketSignature,
  verifyDocuSignSignature,
  verifyAdyenSignature,
  verifyPayPalSignature,
  buildPayPalTransmissionMessage,
} from "../index";
import type { TemplateProvider, VerifySignatureOptions } from "../index";

const client = new WebhooksCC({
  apiKey: "whcc_testkey123",
  baseUrl: "https://test.webhooks.cc",
  webhookUrl: "https://go.test.webhooks.cc",
});

async function exportPublicKeyPem(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const base64 = Buffer.from(new Uint8Array(spki)).toString("base64");
  const wrapped = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

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

  it("verifies DocuSign Connect HMAC signatures", async () => {
    const built = await client.buildRequest("https://example.com/webhooks/docusign", {
      provider: "docusign",
      secret: "docusign_secret",
      body: { event: "envelope-completed", envelopeId: "env_123" },
    });

    expect(
      await verifyDocuSignSignature(
        built.body,
        built.headers["x-docusign-signature-1"],
        "docusign_secret"
      )
    ).toBe(true);
    expect(
      await verifyDocuSignSignature(
        `${built.body} `,
        built.headers["x-docusign-signature-1"],
        "docusign_secret"
      )
    ).toBe(false);

    await expect(
      verifySignature(
        {
          body: built.body,
          headers: { "X-DocuSign-Signature-1": built.headers["x-docusign-signature-1"] },
        },
        { provider: "docusign", secret: "docusign_secret" }
      )
    ).resolves.toEqual({ valid: true });
  });

  it("verifies Adyen standard notification HMAC signatures from the body", async () => {
    // Adyen's official documented HMAC test vector — public, not a secret
    // (https://docs.adyen.com webhook HMAC examples). Kept verbatim so the
    // precomputed signature in the fixture verifies.
    const hmacKey = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056";
    const body = JSON.stringify({
      live: "false",
      notificationItems: [
        {
          NotificationRequestItem: {
            additionalData: {
              hmacSignature: "coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=",
            },
            amount: {
              value: 1130,
              currency: "EUR",
            },
            pspReference: "7914073381342284",
            eventCode: "AUTHORISATION",
            eventDate: "2019-05-06T17:15:34.121+02:00",
            merchantAccountCode: "TestMerchant",
            operations: ["CANCEL", "CAPTURE", "REFUND"],
            merchantReference: "TestPayment-1407325143704",
            paymentMethod: "visa",
            success: "true",
          },
        },
      ],
    });

    expect(await verifyAdyenSignature(body, hmacKey)).toBe(true);
    expect(await verifyAdyenSignature(body, hmacKey.replace(/.$/, "0"))).toBe(false);

    await expect(
      verifySignature({ body, headers: {} }, { provider: "adyen", secret: hmacKey })
    ).resolves.toEqual({ valid: true });
  });

  it("rejects Adyen batches where any item is forged or unsigned", async () => {
    // Adyen's official documented HMAC test vector — public, not a secret
    // (https://docs.adyen.com webhook HMAC examples). Kept verbatim so the
    // precomputed signature in the fixture verifies.
    const hmacKey = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056";
    const validItem = {
      NotificationRequestItem: {
        additionalData: {
          hmacSignature: "coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=",
        },
        amount: { value: 1130, currency: "EUR" },
        pspReference: "7914073381342284",
        eventCode: "AUTHORISATION",
        merchantAccountCode: "TestMerchant",
        merchantReference: "TestPayment-1407325143704",
        success: "true",
      },
    };
    const forgedItem = {
      NotificationRequestItem: {
        ...validItem.NotificationRequestItem,
        amount: { value: 999999, currency: "EUR" },
        merchantReference: "Forged-Item",
      },
    };
    const unsignedFields: Record<string, unknown> = { ...validItem.NotificationRequestItem };
    delete unsignedFields.additionalData;
    const unsignedItem = {
      NotificationRequestItem: { ...unsignedFields, merchantReference: "Unsigned-Item" },
    };

    // One genuine item must not vouch for a forged or unsigned sibling.
    expect(
      await verifyAdyenSignature(
        JSON.stringify({ live: "false", notificationItems: [validItem, forgedItem] }),
        hmacKey
      )
    ).toBe(false);
    expect(
      await verifyAdyenSignature(
        JSON.stringify({ live: "false", notificationItems: [validItem, unsignedItem] }),
        hmacKey
      )
    ).toBe(false);
    // A batch where every item is correctly signed verifies.
    expect(
      await verifyAdyenSignature(
        JSON.stringify({ live: "false", notificationItems: [validItem, validItem] }),
        hmacKey
      )
    ).toBe(true);
  });

  it("verifies PayPal RSA webhook signatures with a fetched certificate public key", async () => {
    const keyPair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    const publicKeyPem = await exportPublicKeyPem(keyPair.publicKey);
    const body = JSON.stringify({ id: "WH-123", event_type: "PAYMENT.CAPTURE.COMPLETED" });
    const transmissionId = "db49fb10-1343-11ef-ac58-e32457403f67";
    const transmissionTime = "2024-05-16T05:19:23Z";
    const webhookId = "WEBHOOK_ID";
    const message = buildPayPalTransmissionMessage(
      body,
      transmissionId,
      transmissionTime,
      webhookId
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      new TextEncoder().encode(message)
    );
    const headers = {
      "paypal-transmission-id": transmissionId,
      "paypal-transmission-time": transmissionTime,
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-transmission-sig": Buffer.from(new Uint8Array(signature)).toString("base64"),
    };

    expect(
      await verifyPayPalSignature(body, headers, webhookId, {
        fetchCertificate: async () => publicKeyPem,
      })
    ).toBe(true);
    expect(
      await verifyPayPalSignature(`${body} `, headers, webhookId, {
        fetchCertificate: async () => publicKeyPem,
      })
    ).toBe(false);

    await expect(
      verifySignature({ body, headers }, {
        provider: "paypal",
        secret: webhookId,
        fetchCertificate: async () => publicKeyPem,
      } as VerifySignatureOptions)
    ).resolves.toEqual({ valid: true });
  });

  it("throws a descriptive error when the PayPal certificate cannot be downloaded", async () => {
    const headers = {
      "paypal-transmission-id": "db49fb10-1343-11ef-ac58-e32457403f67",
      "paypal-transmission-time": "2024-05-16T05:19:23Z",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-down",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-transmission-sig": "c2ln",
    };
    // A download failure is an infrastructure error, not an invalid
    // signature — it must surface as a throw, not a false verdict.
    await expect(
      verifyPayPalSignature("{}", headers, "WEBHOOK_ID", {
        fetchCertificate: async () => {
          throw new Error("connection refused");
        },
      })
    ).rejects.toThrow(/PayPal certificate/);
  });

  it("does not reuse cached certificates across custom PayPal certificate fetchers", async () => {
    const headers = {
      "paypal-transmission-id": "db49fb10-1343-11ef-ac58-e32457403f67",
      "paypal-transmission-time": "2024-05-16T05:19:23Z",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-custom",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-transmission-sig": "c2ln",
    };
    let firstCalls = 0;
    let secondCalls = 0;
    await verifyPayPalSignature("{}", headers, "WEBHOOK_ID", {
      fetchCertificate: async () => {
        firstCalls++;
        return "not a certificate";
      },
    });
    await verifyPayPalSignature("{}", headers, "WEBHOOK_ID", {
      fetchCertificate: async () => {
        secondCalls++;
        return "not a certificate";
      },
    });
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });

  it("aborts the default PayPal certificate download via an AbortSignal timeout", async () => {
    const headers = {
      "paypal-transmission-id": "db49fb10-1343-11ef-ac58-e32457403f67",
      "paypal-transmission-time": "2024-05-16T05:19:23Z",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-signal",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-transmission-sig": "c2ln",
    };
    const originalFetch = globalThis.fetch;
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      receivedSignal = init?.signal;
      return {
        ok: true,
        status: 200,
        text: async () => "not a certificate",
      };
    }) as unknown as typeof fetch;
    try {
      await verifyPayPalSignature("{}", headers, "WEBHOOK_ID");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it("verifySignature throws for plaid (verification unsupported)", async () => {
    await expect(
      verifySignature({ body: "{}", headers: {} }, { provider: "plaid", secret: "anything" })
    ).rejects.toThrow(/Plaid/);
  });

  it("rejects PayPal certificate URLs outside PayPal hosts before fetching", async () => {
    let fetched = false;
    expect(
      await verifyPayPalSignature(
        "{}",
        {
          "paypal-transmission-id": "id",
          "paypal-transmission-time": "2024-05-16T05:19:23Z",
          "paypal-cert-url": "https://example.com/cert.pem",
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-transmission-sig": "invalid",
        },
        "WEBHOOK_ID",
        {
          fetchCertificate: async () => {
            fetched = true;
            return "";
          },
        }
      )
    ).toBe(false);
    expect(fetched).toBe(false);
  });

  it("keeps Plaid template-only until JWT/JWK verification credentials are supported", async () => {
    await expect(
      verifySignature(
        {
          body: "{}",
          headers: { "Plaid-Verification": "eyJhbGciOiJFUzI1NiJ9.eyJpYXQiOjF9.sig" },
        },
        { provider: "plaid", secret: "plaid_secret" } as VerifySignatureOptions
      )
    ).rejects.toThrow(/Plaid webhook verification/);
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

  it("verifies Clerk signatures via Standard Webhooks (Svix) round-trip", async () => {
    const secret = `whsec_${Buffer.from("clerk-test-secret").toString("base64")}`;
    const built = await client.buildRequest("https://example.com/webhooks/clerk", {
      provider: "clerk",
      secret,
      body: { type: "user.created", data: { id: "user_123" } },
      timestamp: 1700000000,
    });

    // Clerk uses Svix/Standard Webhooks headers
    expect(await verifyClerkSignature(built.body, built.headers, secret)).toBe(true);
    expect(await verifyClerkSignature(built.body, built.headers, "whsec_wrongsecret")).toBe(false);

    // Also verify via the generic verifySignature dispatcher
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
        { provider: "clerk", secret }
      )
    ).resolves.toEqual({ valid: true });
  });

  it("verifies Vercel signatures via HMAC-SHA1 round-trip", async () => {
    const built = await client.buildRequest("https://example.com/webhooks/vercel", {
      provider: "vercel",
      secret: "vercel_secret",
      body: { type: "deployment.created", payload: { deploymentId: "dpl_123" } },
    });

    expect(
      await verifyVercelSignature(built.body, built.headers["x-vercel-signature"], "vercel_secret")
    ).toBe(true);
    expect(
      await verifyVercelSignature(built.body, built.headers["x-vercel-signature"], "wrong_secret")
    ).toBe(false);

    // Also verify via the generic verifySignature dispatcher
    await expect(
      verifySignature(
        {
          body: built.body,
          headers: { "X-Vercel-Signature": built.headers["x-vercel-signature"] },
        },
        { provider: "vercel", secret: "vercel_secret" }
      )
    ).resolves.toEqual({ valid: true });
  });

  it("verifies GitLab token matching round-trip", async () => {
    const built = await client.buildRequest("https://example.com/webhooks/gitlab", {
      provider: "gitlab",
      secret: "gitlab_secret_token",
      body: { object_kind: "push", ref: "refs/heads/main" },
    });

    expect(
      await verifyGitLabSignature(
        built.body,
        built.headers["x-gitlab-token"],
        "gitlab_secret_token"
      )
    ).toBe(true);
    expect(
      await verifyGitLabSignature(built.body, built.headers["x-gitlab-token"], "wrong_secret")
    ).toBe(false);

    // Also verify via the generic verifySignature dispatcher
    await expect(
      verifySignature(
        {
          body: built.body,
          headers: { "X-Gitlab-Token": built.headers["x-gitlab-token"] },
        },
        { provider: "gitlab", secret: "gitlab_secret_token" }
      )
    ).resolves.toEqual({ valid: true });
  });

  it("verifies Typeform signatures via HMAC-SHA256 round-trip", async () => {
    const built = await client.buildRequest("https://example.com/webhooks/typeform", {
      provider: "typeform",
      secret: "typeform_secret",
      body: { event_type: "form_response", form_response: { token: "abc" } },
    });

    expect(
      await verifyTypeformSignature(
        built.body,
        built.headers["typeform-signature"],
        "typeform_secret"
      )
    ).toBe(true);
    expect(
      await verifyTypeformSignature(
        `${built.body} `,
        built.headers["typeform-signature"],
        "typeform_secret"
      )
    ).toBe(false);

    await expect(
      verifySignature(
        {
          body: built.body,
          headers: { "Typeform-Signature": built.headers["typeform-signature"] },
        },
        { provider: "typeform", secret: "typeform_secret" }
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

describe("tier-2 Square verification (URL + body scheme)", () => {
  it("verifies Square signatures over notificationURL + body via round-trip + dispatcher", async () => {
    const url = "https://go.webhooks.cc/w/demo";
    const built = await client.buildRequest(url, {
      provider: "square",
      secret: "sq_signature_key",
      body: { type: "payment.created", data: {} },
    });
    const sig = built.headers["x-square-hmacsha256-signature"];
    expect(sig).toBeDefined();

    expect(await verifySquareSignature(url, built.body, sig, "sq_signature_key")).toBe(true);
    // Wrong secret → false
    expect(await verifySquareSignature(url, built.body, sig, "the_wrong_key")).toBe(false);
    // Wrong URL → false (Square binds the signature to the notification URL)
    expect(
      await verifySquareSignature(
        "https://go.webhooks.cc/w/other",
        built.body,
        sig,
        "sq_signature_key"
      )
    ).toBe(false);
    // Tampered body → false
    expect(await verifySquareSignature(url, `${built.body} `, sig, "sq_signature_key")).toBe(false);

    await expect(verifySquareSignature(url, built.body, sig, "")).rejects.toThrow(
      "requires a non-empty secret"
    );

    await expect(verifySquareSignature("", built.body, sig, "sq_signature_key")).rejects.toThrow(
      "requires the notification URL"
    );

    // Dispatcher requires options.url
    await expect(
      verifySignature(
        {
          body: built.body,
          headers: { "X-Square-HmacSha256-Signature": sig },
        },
        { provider: "square", secret: "sq_signature_key" }
      )
    ).rejects.toThrow("requires options.url");

    await expect(
      verifySignature(
        {
          body: built.body,
          headers: { "X-Square-HmacSha256-Signature": sig },
        },
        { provider: "square", secret: "sq_signature_key", url }
      )
    ).resolves.toEqual({ valid: true });
  });
});

describe("tier-2 HubSpot verification (method + URI + body + timestamp scheme)", () => {
  it("verifies HubSpot v3 signatures via round-trip + dispatcher", async () => {
    const url = "https://go.webhooks.cc/w/demo";
    const nowSec = Math.floor(Date.now() / 1000);
    const built = await client.buildRequest(url, {
      provider: "hubspot",
      secret: "hs_app_client_secret",
      body: [{ subscriptionType: "contact.creation", objectId: 1 }],
      timestamp: nowSec,
    });
    const sig = built.headers["x-hubspot-signature-v3"];
    const ts = built.headers["x-hubspot-request-timestamp"];
    expect(sig).toBeDefined();
    expect(ts).toBe(String(nowSec * 1000));

    // Use a wide maxAgeMs window so the test is never time-flaky.
    const wide = 60 * 60 * 1000;
    expect(
      await verifyHubSpotSignature("POST", url, built.body, sig, ts, "hs_app_client_secret", wide)
    ).toBe(true);
    // Wrong secret → false
    expect(
      await verifyHubSpotSignature("POST", url, built.body, sig, ts, "the_wrong_secret", wide)
    ).toBe(false);
    // Wrong method → false (HubSpot binds the signature to the HTTP method)
    expect(
      await verifyHubSpotSignature("GET", url, built.body, sig, ts, "hs_app_client_secret", wide)
    ).toBe(false);
    // Wrong URL → false (HubSpot binds the signature to the request URI)
    expect(
      await verifyHubSpotSignature(
        "POST",
        "https://go.webhooks.cc/w/other",
        built.body,
        sig,
        ts,
        "hs_app_client_secret",
        wide
      )
    ).toBe(false);
    // Tampered body → false
    expect(
      await verifyHubSpotSignature(
        "POST",
        url,
        `${built.body} `,
        sig,
        ts,
        "hs_app_client_secret",
        wide
      )
    ).toBe(false);
    // Missing signature header / timestamp → false (does not throw)
    expect(
      await verifyHubSpotSignature("POST", url, built.body, null, ts, "hs_app_client_secret", wide)
    ).toBe(false);
    expect(
      await verifyHubSpotSignature("POST", url, built.body, sig, null, "hs_app_client_secret", wide)
    ).toBe(false);

    // Empty secret throws.
    await expect(
      verifyHubSpotSignature("POST", url, built.body, sig, ts, "", wide)
    ).rejects.toThrow("requires a non-empty secret");

    // Dispatcher requires options.url
    await expect(
      verifySignature(
        {
          body: built.body,
          headers: { "X-HubSpot-Signature-V3": sig, "X-HubSpot-Request-Timestamp": ts },
        },
        { provider: "hubspot", secret: "hs_app_client_secret" }
      )
    ).rejects.toThrow("requires options.url");

    await expect(
      verifySignature(
        {
          body: built.body,
          headers: { "X-HubSpot-Signature-V3": sig, "X-HubSpot-Request-Timestamp": ts },
        },
        { provider: "hubspot", secret: "hs_app_client_secret", url, method: "POST" }
      )
    ).resolves.toEqual({ valid: true });
  });

  it("decodes HubSpot's reserved-character map in the signed URI", async () => {
    // HubSpot decodes a documented set of percent-encoded chars before signing.
    // The signer normalizes the URI, so a request signed for an encoded URL must
    // verify against both the encoded and the decoded form of that same URL.
    const encodedUrl = "https://go.webhooks.cc/w/demo%2Fteam%40acme?ids=1%2C2%3B3";
    const decodedUrl = "https://go.webhooks.cc/w/demo/team@acme?ids=1,2;3";
    const nowSec = Math.floor(Date.now() / 1000);
    const built = await client.buildRequest(encodedUrl, {
      provider: "hubspot",
      secret: "hs_app_client_secret",
      body: [{ subscriptionType: "contact.creation", objectId: 1 }],
      timestamp: nowSec,
    });
    const sig = built.headers["x-hubspot-signature-v3"];
    const ts = built.headers["x-hubspot-request-timestamp"];
    const wide = 60 * 60 * 1000;

    // Encoded URL verifies (verifier applies the same decode as the signer).
    expect(
      await verifyHubSpotSignature(
        "POST",
        encodedUrl,
        built.body,
        sig,
        ts,
        "hs_app_client_secret",
        wide
      )
    ).toBe(true);
    // Pre-decoded URL also verifies — proving the signature was computed over the
    // decoded URI, matching what real HubSpot produces.
    expect(
      await verifyHubSpotSignature(
        "POST",
        decodedUrl,
        built.body,
        sig,
        ts,
        "hs_app_client_secret",
        wide
      )
    ).toBe(true);
    // A genuinely different URL still fails.
    expect(
      await verifyHubSpotSignature(
        "POST",
        "https://go.webhooks.cc/w/demo/other@acme?ids=1,2;3",
        built.body,
        sig,
        ts,
        "hs_app_client_secret",
        wide
      )
    ).toBe(false);
  });

  it("rejects a stale timestamp (older than the freshness window)", async () => {
    const url = "https://go.webhooks.cc/w/demo";
    // Sign with a deterministic timestamp ~10 minutes in the past.
    const staleSec = Math.floor(Date.now() / 1000) - 10 * 60;
    const built = await client.buildRequest(url, {
      provider: "hubspot",
      secret: "hs_app_client_secret",
      body: [{ subscriptionType: "contact.creation" }],
      timestamp: staleSec,
    });
    const sig = built.headers["x-hubspot-signature-v3"];
    const ts = built.headers["x-hubspot-request-timestamp"];

    // Default 5-minute window: stale → false (signature is otherwise correct).
    expect(
      await verifyHubSpotSignature("POST", url, built.body, sig, ts, "hs_app_client_secret")
    ).toBe(false);
    // Dispatcher uses the default window, so it must also reject.
    await expect(
      verifySignature(
        {
          body: built.body,
          headers: { "x-hubspot-signature-v3": sig, "x-hubspot-request-timestamp": ts },
        },
        { provider: "hubspot", secret: "hs_app_client_secret", url, method: "POST" }
      )
    ).resolves.toEqual({ valid: false });
    // But widening the window proves the signature itself is valid.
    expect(
      await verifyHubSpotSignature(
        "POST",
        url,
        built.body,
        sig,
        ts,
        "hs_app_client_secret",
        60 * 60 * 1000
      )
    ).toBe(true);
  });
});

describe("tier-2 Mailgun verification (body-embedded signature scheme)", () => {
  it("verifies Mailgun signatures over the body signature fields via round-trip + dispatcher", async () => {
    const built = await client.buildRequest("https://go.webhooks.cc/w/demo", {
      provider: "mailgun",
      secret: "mg_signing_key",
    });
    // Mailgun embeds the signature in the body; there is no signature header.
    expect(built.headers["x-mailgun-signature"]).toBeUndefined();
    expect(built.body).toBeDefined();
    const builtBody = built.body as string;

    expect(await verifyMailgunSignature(builtBody, "mg_signing_key")).toBe(true);
    // Wrong secret → false
    expect(await verifyMailgunSignature(builtBody, "the_wrong_key")).toBe(false);
    // Tampered body (token altered) → false
    const parsed = JSON.parse(builtBody) as {
      signature: { timestamp: string; token: string; signature: string };
    };
    const tampered = JSON.stringify({
      ...parsed,
      signature: { ...parsed.signature, token: `${parsed.signature.token}0` },
    });
    expect(await verifyMailgunSignature(tampered, "mg_signing_key")).toBe(false);

    // Malformed / non-JSON body → false (NEVER throws)
    expect(await verifyMailgunSignature("not json at all", "mg_signing_key")).toBe(false);
    expect(await verifyMailgunSignature("{", "mg_signing_key")).toBe(false);
    expect(await verifyMailgunSignature("{}", "mg_signing_key")).toBe(false);
    expect(await verifyMailgunSignature(undefined, "mg_signing_key")).toBe(false);
    // Missing signature sub-fields → false (no throw)
    expect(
      await verifyMailgunSignature(
        JSON.stringify({ signature: { timestamp: "1" } }),
        "mg_signing_key"
      )
    ).toBe(false);

    // Empty secret still throws (consistent with other verifiers).
    await expect(verifyMailgunSignature(builtBody, "")).rejects.toThrow(
      "requires a non-empty secret"
    );

    // Dispatcher path (no headers, body-only).
    await expect(
      verifySignature(
        { body: builtBody, headers: {} },
        { provider: "mailgun", secret: "mg_signing_key" }
      )
    ).resolves.toEqual({ valid: true });

    // Dispatcher with malformed body resolves to false without throwing.
    await expect(
      verifySignature(
        { body: "not json", headers: {} },
        { provider: "mailgun", secret: "mg_signing_key" }
      )
    ).resolves.toEqual({ valid: false });
  });
});

describe("tier-2 Calendly verification (Stripe-style t=,v1= scheme)", () => {
  it("verifies Calendly signatures over t.body via round-trip + dispatcher", async () => {
    const built = await client.buildRequest("https://go.webhooks.cc/w/demo", {
      provider: "calendly",
      secret: "cal_signing_key",
    });
    const sig = built.headers["calendly-webhook-signature"];
    expect(sig).toBeDefined();
    // Stripe-style header shape: t=<unix>,v1=<hex>
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]+$/);

    expect(await verifyCalendlySignature(built.body, sig, "cal_signing_key")).toBe(true);
    // Wrong secret → false
    expect(await verifyCalendlySignature(built.body, sig, "the_wrong_key")).toBe(false);
    // Tampered body → false (signature is bound to the exact body)
    expect(await verifyCalendlySignature(`${built.body} `, sig, "cal_signing_key")).toBe(false);
    // Missing / malformed header → false (no throw)
    expect(await verifyCalendlySignature(built.body, undefined, "cal_signing_key")).toBe(false);
    expect(await verifyCalendlySignature(built.body, "garbage", "cal_signing_key")).toBe(false);

    // Empty secret throws (consistent with other verifiers).
    await expect(verifyCalendlySignature(built.body, sig, "")).rejects.toThrow(
      "requires a non-empty secret"
    );

    // Dispatcher path with a mixed-case header (case-insensitive lookup).
    await expect(
      verifySignature(
        { body: built.body, headers: { "Calendly-Webhook-Signature": sig } },
        { provider: "calendly", secret: "cal_signing_key" }
      )
    ).resolves.toEqual({ valid: true });

    // Dispatcher with wrong secret resolves to false.
    await expect(
      verifySignature(
        { body: built.body, headers: { "calendly-webhook-signature": sig } },
        { provider: "calendly", secret: "the_wrong_key" }
      )
    ).resolves.toEqual({ valid: false });
  });
});

describe("tier-2 Mux verification (Stripe-style t=,v1= scheme)", () => {
  it("verifies Mux signatures over t.body via round-trip + dispatcher", async () => {
    const built = await client.buildRequest("https://go.webhooks.cc/w/demo", {
      provider: "mux",
      secret: "mux_signing_secret",
    });
    const sig = built.headers["mux-signature"];
    expect(sig).toBeDefined();
    // Stripe-style header shape: t=<unix>,v1=<hex>
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]+$/);

    expect(await verifyMuxSignature(built.body, sig, "mux_signing_secret")).toBe(true);
    // Wrong secret → false
    expect(await verifyMuxSignature(built.body, sig, "the_wrong_key")).toBe(false);
    // Tampered body → false (signature is bound to the exact body)
    expect(await verifyMuxSignature(`${built.body} `, sig, "mux_signing_secret")).toBe(false);
    // Missing / malformed header → false (no throw)
    expect(await verifyMuxSignature(built.body, undefined, "mux_signing_secret")).toBe(false);
    expect(await verifyMuxSignature(built.body, "garbage", "mux_signing_secret")).toBe(false);

    // Empty secret throws (consistent with other verifiers).
    await expect(verifyMuxSignature(built.body, sig, "")).rejects.toThrow(
      "requires a non-empty secret"
    );

    // Dispatcher path with a mixed-case header (case-insensitive lookup).
    await expect(
      verifySignature(
        { body: built.body, headers: { "Mux-Signature": sig } },
        { provider: "mux", secret: "mux_signing_secret" }
      )
    ).resolves.toEqual({ valid: true });

    // Dispatcher with wrong secret resolves to false.
    await expect(
      verifySignature(
        { body: built.body, headers: { "mux-signature": sig } },
        { provider: "mux", secret: "the_wrong_key" }
      )
    ).resolves.toEqual({ valid: false });
  });
});

describe("tier-2 Sentry verification (hex HMAC-SHA256 over body)", () => {
  it("verifies Sentry signatures over the raw body via round-trip + dispatcher", async () => {
    const built = await client.buildRequest("https://go.webhooks.cc/w/demo", {
      provider: "sentry",
      secret: "sentry_client_secret",
    });
    const sig = built.headers["sentry-hook-signature"];
    expect(sig).toBeDefined();
    // Raw hex HMAC-SHA256, no prefix.
    expect(sig).toMatch(/^[0-9a-f]+$/);
    // Sentry also carries the event resource header.
    expect(built.headers["sentry-hook-resource"]).toBe("issue");

    expect(await verifySentrySignature(built.body, sig, "sentry_client_secret")).toBe(true);
    // Wrong secret → false
    expect(await verifySentrySignature(built.body, sig, "the_wrong_key")).toBe(false);
    // Tampered body → false (signature is bound to the exact body)
    expect(await verifySentrySignature(`${built.body} `, sig, "sentry_client_secret")).toBe(false);
    // Missing header → false (no throw)
    expect(await verifySentrySignature(built.body, undefined, "sentry_client_secret")).toBe(false);

    // Empty secret throws (consistent with other verifiers).
    await expect(verifySentrySignature(built.body, sig, "")).rejects.toThrow(
      "requires a non-empty secret"
    );

    // Dispatcher path with a mixed-case header (case-insensitive lookup).
    await expect(
      verifySignature(
        { body: built.body, headers: { "Sentry-Hook-Signature": sig } },
        { provider: "sentry", secret: "sentry_client_secret" }
      )
    ).resolves.toEqual({ valid: true });

    // Dispatcher with wrong secret resolves to false.
    await expect(
      verifySignature(
        { body: built.body, headers: { "sentry-hook-signature": sig } },
        { provider: "sentry", secret: "the_wrong_key" }
      )
    ).resolves.toEqual({ valid: false });
  });
});

describe("tier-2 Bitbucket verification (sha256= hex over body)", () => {
  it("verifies Bitbucket signatures over the raw body via round-trip + dispatcher", async () => {
    const built = await client.buildRequest("https://go.webhooks.cc/w/demo", {
      provider: "bitbucket",
      secret: "bitbucket_webhook_secret",
    });
    const sig = built.headers["x-hub-signature"];
    expect(sig).toBeDefined();
    // GitHub-style sha256= hex prefix.
    expect(sig).toMatch(/^sha256=[0-9a-f]+$/);
    // Bitbucket carries the event in the x-event-key header.
    expect(built.headers["x-event-key"]).toBe("repo:push");

    expect(await verifyBitbucketSignature(built.body, sig, "bitbucket_webhook_secret")).toBe(true);
    // Wrong secret → false
    expect(await verifyBitbucketSignature(built.body, sig, "the_wrong_key")).toBe(false);
    // Tampered body → false (signature is bound to the exact body)
    expect(await verifyBitbucketSignature(`${built.body} `, sig, "bitbucket_webhook_secret")).toBe(
      false
    );
    // Missing header → false (no throw)
    expect(await verifyBitbucketSignature(built.body, undefined, "bitbucket_webhook_secret")).toBe(
      false
    );
    // A sha1= header (Intercom-style) must not validate as Bitbucket sha256=.
    expect(
      await verifyBitbucketSignature(built.body, "sha1=deadbeef", "bitbucket_webhook_secret")
    ).toBe(false);

    // Empty secret throws (consistent with other verifiers).
    await expect(verifyBitbucketSignature(built.body, sig, "")).rejects.toThrow(
      "requires a non-empty secret"
    );

    // Dispatcher path with a mixed-case header (case-insensitive lookup).
    await expect(
      verifySignature(
        { body: built.body, headers: { "X-Hub-Signature": sig, "x-event-key": "repo:push" } },
        { provider: "bitbucket", secret: "bitbucket_webhook_secret" }
      )
    ).resolves.toEqual({ valid: true });

    // Dispatcher with wrong secret resolves to false.
    await expect(
      verifySignature(
        { body: built.body, headers: { "x-hub-signature": sig } },
        { provider: "bitbucket", secret: "the_wrong_key" }
      )
    ).resolves.toEqual({ valid: false });
  });
});

describe("tier-1 provider verification round-trips", () => {
  const tier1: ReadonlyArray<{
    provider: TemplateProvider;
    header: string;
    verify: (
      body: string | undefined,
      header: string | null | undefined,
      secret: string
    ) => Promise<boolean>;
    secret: string;
    body: Record<string, unknown>;
    tamperable: boolean;
  }> = [
    {
      provider: "meta",
      header: "x-hub-signature-256",
      verify: verifyMetaSignature,
      secret: "app_secret",
      body: { object: "whatsapp_business_account", entry: [] },
      tamperable: true,
    },
    {
      provider: "lemonsqueezy",
      header: "x-signature",
      verify: verifyLemonSqueezySignature,
      secret: "ls_secret",
      body: { meta: { event_name: "order_created" }, data: {} },
      tamperable: true,
    },
    {
      provider: "coinbase-commerce",
      header: "x-cc-webhook-signature",
      verify: verifyCoinbaseCommerceSignature,
      secret: "cb_secret",
      body: { event: { type: "charge:confirmed" } },
      tamperable: true,
    },
    {
      provider: "razorpay",
      header: "x-razorpay-signature",
      verify: verifyRazorpaySignature,
      secret: "rp_secret",
      body: { event: "payment.captured" },
      tamperable: true,
    },
    {
      provider: "cal",
      header: "x-cal-signature-256",
      verify: verifyCalSignature,
      secret: "cal_secret",
      body: { triggerEvent: "BOOKING_CREATED" },
      tamperable: true,
    },
    {
      provider: "intercom",
      header: "x-hub-signature",
      verify: verifyIntercomSignature,
      secret: "ic_secret",
      body: { type: "notification_event", topic: "conversation.user.created" },
      tamperable: true,
    },
    {
      provider: "telegram",
      header: "x-telegram-bot-api-secret-token",
      verify: verifyTelegramSignature,
      secret: "tg_secret",
      body: { update_id: 1, message: { text: "hi" } },
      tamperable: false,
    },
  ];

  for (const { provider, header, verify, secret, body, tamperable } of tier1) {
    it(`verifies ${provider} via buildRequest round-trip + dispatcher`, async () => {
      const built = await client.buildRequest(`https://example.com/${provider}`, {
        provider,
        secret,
        body,
      });
      const sig = built.headers[header];
      expect(sig).toBeDefined();

      expect(await verify(built.body, sig, secret)).toBe(true);
      expect(await verify(built.body, sig, "the_wrong_secret")).toBe(false);
      if (tamperable) {
        expect(await verify(`${built.body} `, sig, secret)).toBe(false);
      }

      await expect(
        verifySignature({ body: built.body, headers: { [header]: sig! } }, {
          provider,
          secret,
        } as Parameters<typeof verifySignature>[1])
      ).resolves.toEqual({ valid: true });
    });
  }

  it("verifyIntercomSignature rejects a sha256= signature (wrong prefix/algorithm)", async () => {
    const built = await client.buildRequest("https://example.com/intercom", {
      provider: "intercom",
      secret: "ic_secret",
      body: { type: "notification_event", topic: "conversation.user.created" },
    });
    const tampered = built.headers["x-hub-signature"].replace(/^sha1=/, "sha256=");
    expect(await verifyIntercomSignature(built.body, tampered, "ic_secret")).toBe(false);
  });

  it("verifyTelegramSignature matches the raw secret token independent of body", async () => {
    const built = await client.buildRequest("https://example.com/telegram", {
      provider: "telegram",
      secret: "tg_token_value",
      body: { update_id: 7 },
    });
    expect(built.headers["x-telegram-bot-api-secret-token"]).toBe("tg_token_value");
    expect(await verifyTelegramSignature(built.body, "tg_token_value", "tg_token_value")).toBe(
      true
    );
    expect(await verifyTelegramSignature(built.body, "tg_token_value", "different")).toBe(false);
  });
});

describe("VerifySignatureOptions type surface (tier-2)", () => {
  it("accepts an optional method field on the non-discord branch", () => {
    // Type-only assertion: tier-2 providers like HubSpot sign
    // method + URI + body + timestamp, so the options carry an HTTP method.
    const options: VerifySignatureOptions = {
      provider: "stripe",
      secret: "whsec_test",
      url: "https://go.webhooks.cc/w/demo",
      method: "POST",
    };
    expect(options.provider).toBe("stripe");
    expect("method" in options && options.method).toBe("POST");
  });

  it("keeps method optional", () => {
    const options: VerifySignatureOptions = {
      provider: "stripe",
      secret: "whsec_test",
    };
    expect(options.provider).toBe("stripe");
  });
});
