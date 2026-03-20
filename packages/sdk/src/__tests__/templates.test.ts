import { describe, expect, it } from "vitest";
import { buildTemplateSendOptions } from "../templates";
import {
  verifyStripeSignature,
  verifyGitHubSignature,
  verifyShopifySignature,
  verifyTwilioSignature,
  verifySlackSignature,
  verifyPaddleSignature,
  verifyLinearSignature,
  verifyClerkSignature,
  verifyVercelSignature,
  verifyGitLabSignature,
  verifySignature,
} from "../verify";

const TEST_SECRET = "test_secret_123";
const ENDPOINT_URL = "https://go.webhooks.cc/w/test-slug";

// ─── Helpers ────────────────────────────────────────────────────────────

function parseBody(body: string): unknown {
  return JSON.parse(body);
}

function parseFormBody(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

// ─── Stripe ─────────────────────────────────────────────────────────────

describe("Stripe templates", () => {
  const STRIPE_TEMPLATES = [
    "payment_intent.succeeded",
    "checkout.session.completed",
    "invoice.paid",
  ] as const;

  for (const template of STRIPE_TEMPLATES) {
    describe(`template: ${template}`, () => {
      it("produces valid JSON with correct Content-Type", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "stripe",
          secret: TEST_SECRET,
          template,
        });
        expect(result.headers["content-type"]).toBe("application/json");
        expect(() => JSON.parse(result.body!)).not.toThrow();
      });

      it("has correct Stripe event structure", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "stripe",
          secret: TEST_SECRET,
          template,
        });
        const body = parseBody(result.body!) as Record<string, unknown>;

        // Required Stripe event fields per https://docs.stripe.com/api/events/object
        expect(body).toHaveProperty("id");
        expect(typeof body.id).toBe("string");
        expect((body.id as string).startsWith("evt_")).toBe(true);

        expect(body.object).toBe("event");

        expect(body).toHaveProperty("api_version");
        expect(typeof body.api_version).toBe("string");

        expect(body).toHaveProperty("created");
        expect(typeof body.created).toBe("number");

        expect(body).toHaveProperty("data");
        const data = body.data as Record<string, unknown>;
        expect(data).toHaveProperty("object");
        expect(typeof data.object).toBe("object");

        expect(body).toHaveProperty("type");
        expect(body.type).toBe(template);

        expect(typeof body.livemode).toBe("boolean");
        expect(body.livemode).toBe(false);

        expect(body).toHaveProperty("pending_webhooks");
        expect(body).toHaveProperty("request");
      });

      it("has stripe-signature header", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "stripe",
          secret: TEST_SECRET,
          template,
        });
        const sig = getHeader(result.headers, "stripe-signature");
        expect(sig).toBeDefined();
        expect(sig).toMatch(/^t=\d+,v1=[a-f0-9]+$/);
      });

      it("signature verifies correctly", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "stripe",
          secret: TEST_SECRET,
          template,
        });
        const sig = getHeader(result.headers, "stripe-signature")!;
        expect(await verifyStripeSignature(result.body, sig, TEST_SECRET)).toBe(true);
        expect(await verifyStripeSignature(result.body, sig, "wrong_secret")).toBe(false);
      });
    });
  }

  it("payment_intent.succeeded data.object has payment_intent fields", async () => {
    const result = await buildTemplateSendOptions(ENDPOINT_URL, {
      provider: "stripe",
      secret: TEST_SECRET,
      template: "payment_intent.succeeded",
    });
    const body = parseBody(result.body!) as Record<string, unknown>;
    const dataObj = (body.data as Record<string, unknown>).object as Record<string, unknown>;
    expect(dataObj.object).toBe("payment_intent");
    expect(dataObj).toHaveProperty("amount");
    expect(dataObj).toHaveProperty("amount_received");
    expect(dataObj).toHaveProperty("currency");
    expect(dataObj).toHaveProperty("status");
    expect(dataObj.status).toBe("succeeded");
  });

  it("has user-agent header", async () => {
    const result = await buildTemplateSendOptions(ENDPOINT_URL, {
      provider: "stripe",
      secret: TEST_SECRET,
    });
    expect(getHeader(result.headers, "user-agent")).toMatch(/Stripe/);
  });
});

// ─── GitHub ─────────────────────────────────────────────────────────────

describe("GitHub templates", () => {
  describe("push template", () => {
    it("produces valid JSON with correct Content-Type", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "github",
        secret: TEST_SECRET,
        template: "push",
      });
      expect(result.headers["content-type"]).toBe("application/json");
      expect(() => JSON.parse(result.body!)).not.toThrow();
    });

    it("has correct push payload shape", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "github",
        secret: TEST_SECRET,
        template: "push",
      });
      const body = parseBody(result.body!) as Record<string, unknown>;

      expect(body).toHaveProperty("ref");
      expect(typeof body.ref).toBe("string");
      expect((body.ref as string).startsWith("refs/heads/")).toBe(true);

      expect(body).toHaveProperty("commits");
      expect(Array.isArray(body.commits)).toBe(true);
      expect((body.commits as unknown[]).length).toBeGreaterThan(0);

      expect(body).toHaveProperty("repository");
      const repo = body.repository as Record<string, unknown>;
      expect(repo).toHaveProperty("id");
      expect(repo).toHaveProperty("full_name");

      expect(body).toHaveProperty("pusher");
      const pusher = body.pusher as Record<string, unknown>;
      expect(pusher).toHaveProperty("name");
      expect(pusher).toHaveProperty("email");

      expect(body).toHaveProperty("head_commit");
      expect(body).toHaveProperty("before");
      expect(body).toHaveProperty("after");
      expect(body).toHaveProperty("sender");
    });

    it("has x-github-event and x-hub-signature-256 headers", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "github",
        secret: TEST_SECRET,
        template: "push",
      });
      expect(getHeader(result.headers, "x-github-event")).toBe("push");
      expect(getHeader(result.headers, "x-github-delivery")).toBeDefined();

      const sig = getHeader(result.headers, "x-hub-signature-256");
      expect(sig).toBeDefined();
      expect(sig).toMatch(/^sha256=[a-f0-9]+$/);
    });

    it("signature verifies correctly", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "github",
        secret: TEST_SECRET,
        template: "push",
      });
      const sig = getHeader(result.headers, "x-hub-signature-256")!;
      expect(await verifyGitHubSignature(result.body, sig, TEST_SECRET)).toBe(true);
      expect(await verifyGitHubSignature(result.body, sig, "wrong_secret")).toBe(false);
    });
  });

  describe("pull_request.opened template", () => {
    it("has correct PR payload shape", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "github",
        secret: TEST_SECRET,
        template: "pull_request.opened",
      });
      const body = parseBody(result.body!) as Record<string, unknown>;

      expect(body).toHaveProperty("action");
      expect(body.action).toBe("opened");

      expect(body).toHaveProperty("pull_request");
      const pr = body.pull_request as Record<string, unknown>;
      expect(pr).toHaveProperty("id");
      expect(pr).toHaveProperty("number");
      expect(pr).toHaveProperty("state");
      expect(pr).toHaveProperty("title");
      expect(pr).toHaveProperty("head");
      expect(pr).toHaveProperty("base");

      expect(body).toHaveProperty("repository");
      expect(body).toHaveProperty("sender");
    });

    it("x-github-event is pull_request (not pull_request.opened)", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "github",
        secret: TEST_SECRET,
        template: "pull_request.opened",
      });
      expect(getHeader(result.headers, "x-github-event")).toBe("pull_request");
    });

    it("signature verifies correctly", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "github",
        secret: TEST_SECRET,
        template: "pull_request.opened",
      });
      const sig = getHeader(result.headers, "x-hub-signature-256")!;
      expect(await verifyGitHubSignature(result.body, sig, TEST_SECRET)).toBe(true);
    });
  });

  describe("ping template", () => {
    it("has correct ping payload shape", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "github",
        secret: TEST_SECRET,
        template: "ping",
      });
      const body = parseBody(result.body!) as Record<string, unknown>;

      expect(body).toHaveProperty("zen");
      expect(typeof body.zen).toBe("string");
      expect(body).toHaveProperty("hook_id");
      expect(body).toHaveProperty("hook");
      expect(body).toHaveProperty("repository");
      expect(body).toHaveProperty("sender");
    });

    it("signature verifies correctly", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "github",
        secret: TEST_SECRET,
        template: "ping",
      });
      const sig = getHeader(result.headers, "x-hub-signature-256")!;
      expect(await verifyGitHubSignature(result.body, sig, TEST_SECRET)).toBe(true);
    });
  });
});

// ─── Shopify ────────────────────────────────────────────────────────────

describe("Shopify templates", () => {
  describe("orders/create template", () => {
    it("produces valid JSON with correct Content-Type", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "shopify",
        secret: TEST_SECRET,
        template: "orders/create",
      });
      expect(result.headers["content-type"]).toBe("application/json");
      expect(() => JSON.parse(result.body!)).not.toThrow();
    });

    it("has correct order payload shape", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "shopify",
        secret: TEST_SECRET,
        template: "orders/create",
      });
      const body = parseBody(result.body!) as Record<string, unknown>;

      expect(body).toHaveProperty("id");
      expect(typeof body.id).toBe("number");

      expect(body).toHaveProperty("email");
      expect(typeof body.email).toBe("string");

      expect(body).toHaveProperty("financial_status");

      expect(body).toHaveProperty("line_items");
      expect(Array.isArray(body.line_items)).toBe(true);
      const lineItems = body.line_items as Record<string, unknown>[];
      expect(lineItems.length).toBeGreaterThan(0);
      expect(lineItems[0]).toHaveProperty("title");
      expect(lineItems[0]).toHaveProperty("quantity");
      expect(lineItems[0]).toHaveProperty("price");
    });

    it("has x-shopify-topic and x-shopify-hmac-sha256 headers", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "shopify",
        secret: TEST_SECRET,
        template: "orders/create",
      });
      expect(getHeader(result.headers, "x-shopify-topic")).toBe("orders/create");
      expect(getHeader(result.headers, "x-shopify-hmac-sha256")).toBeDefined();
      expect(getHeader(result.headers, "x-shopify-shop-domain")).toBeDefined();
      expect(getHeader(result.headers, "x-shopify-api-version")).toBeDefined();
      expect(getHeader(result.headers, "x-shopify-webhook-id")).toBeDefined();
    });

    it("signature verifies correctly", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "shopify",
        secret: TEST_SECRET,
        template: "orders/create",
      });
      const sig = getHeader(result.headers, "x-shopify-hmac-sha256")!;
      expect(await verifyShopifySignature(result.body, sig, TEST_SECRET)).toBe(true);
      expect(await verifyShopifySignature(result.body, sig, "wrong_secret")).toBe(false);
    });
  });

  for (const template of ["orders/paid", "products/update", "app/uninstalled"] as const) {
    it(`${template} template produces valid signed JSON`, async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "shopify",
        secret: TEST_SECRET,
        template,
      });
      expect(result.headers["content-type"]).toBe("application/json");
      expect(() => JSON.parse(result.body!)).not.toThrow();
      const sig = getHeader(result.headers, "x-shopify-hmac-sha256")!;
      expect(await verifyShopifySignature(result.body, sig, TEST_SECRET)).toBe(true);
    });
  }
});

// ─── Twilio ─────────────────────────────────────────────────────────────

describe("Twilio templates", () => {
  const TWILIO_TEMPLATES = [
    "messaging.inbound",
    "messaging.status_callback",
    "voice.incoming_call",
  ] as const;

  for (const template of TWILIO_TEMPLATES) {
    describe(`template: ${template}`, () => {
      it("produces form-encoded body with correct Content-Type", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "twilio",
          secret: TEST_SECRET,
          template,
        });
        expect(result.headers["content-type"]).toBe("application/x-www-form-urlencoded");

        // Should be parseable as URL params
        const params = parseFormBody(result.body!);
        expect(Object.keys(params).length).toBeGreaterThan(0);
      });

      it("has required Twilio fields", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "twilio",
          secret: TEST_SECRET,
          template,
        });
        const params = parseFormBody(result.body!);

        // All Twilio webhooks include AccountSid
        expect(params).toHaveProperty("AccountSid");
        expect(params.AccountSid).toMatch(/^AC[a-f0-9]+$/);

        // All include From and To
        expect(params).toHaveProperty("From");
        expect(params).toHaveProperty("To");
      });

      it("has x-twilio-signature header", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "twilio",
          secret: TEST_SECRET,
          template,
        });
        const sig = getHeader(result.headers, "x-twilio-signature");
        expect(sig).toBeDefined();
      });

      it("signature verifies correctly", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "twilio",
          secret: TEST_SECRET,
          template,
        });
        const sig = getHeader(result.headers, "x-twilio-signature")!;
        expect(await verifyTwilioSignature(ENDPOINT_URL, result.body, sig, TEST_SECRET)).toBe(true);
        expect(await verifyTwilioSignature(ENDPOINT_URL, result.body, sig, "wrong_secret")).toBe(
          false
        );
      });
    });
  }

  it("messaging.inbound has MessageSid, Body fields", async () => {
    const result = await buildTemplateSendOptions(ENDPOINT_URL, {
      provider: "twilio",
      secret: TEST_SECRET,
      template: "messaging.inbound",
    });
    const params = parseFormBody(result.body!);
    expect(params).toHaveProperty("MessageSid");
    expect(params.MessageSid).toMatch(/^SM[a-f0-9]+$/);
    expect(params).toHaveProperty("Body");
  });

  it("voice.incoming_call has CallSid, CallStatus fields", async () => {
    const result = await buildTemplateSendOptions(ENDPOINT_URL, {
      provider: "twilio",
      secret: TEST_SECRET,
      template: "voice.incoming_call",
    });
    const params = parseFormBody(result.body!);
    expect(params).toHaveProperty("CallSid");
    expect(params.CallSid).toMatch(/^CA[a-f0-9]+$/);
    expect(params).toHaveProperty("CallStatus");
  });
});

// ─── Slack ──────────────────────────────────────────────────────────────

describe("Slack templates", () => {
  describe("event_callback template", () => {
    it("produces valid JSON with correct Content-Type", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "slack",
        secret: TEST_SECRET,
        template: "event_callback",
      });
      expect(result.headers["content-type"]).toBe("application/json");
      expect(() => JSON.parse(result.body!)).not.toThrow();
    });

    it("has correct event_callback payload shape", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "slack",
        secret: TEST_SECRET,
        template: "event_callback",
      });
      const body = parseBody(result.body!) as Record<string, unknown>;

      expect(body.type).toBe("event_callback");
      expect(body).toHaveProperty("team_id");
      expect(typeof body.team_id).toBe("string");

      expect(body).toHaveProperty("event");
      const event = body.event as Record<string, unknown>;
      expect(event).toHaveProperty("type");

      expect(body).toHaveProperty("event_id");
      expect(body).toHaveProperty("event_time");
      expect(body).toHaveProperty("api_app_id");
    });

    it("has x-slack-signature and x-slack-request-timestamp headers", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "slack",
        secret: TEST_SECRET,
        template: "event_callback",
      });
      const sig = getHeader(result.headers, "x-slack-signature");
      expect(sig).toBeDefined();
      expect(sig).toMatch(/^v0=[a-f0-9]+$/);
      expect(getHeader(result.headers, "x-slack-request-timestamp")).toBeDefined();
    });

    it("signature verifies correctly", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "slack",
        secret: TEST_SECRET,
        template: "event_callback",
      });
      expect(await verifySlackSignature(result.body, result.headers, TEST_SECRET)).toBe(true);
      expect(await verifySlackSignature(result.body, result.headers, "wrong_secret")).toBe(false);
    });
  });

  describe("slash_command template", () => {
    it("produces form-encoded body with correct Content-Type", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "slack",
        secret: TEST_SECRET,
        template: "slash_command",
      });
      expect(result.headers["content-type"]).toBe("application/x-www-form-urlencoded");

      const params = parseFormBody(result.body!);
      expect(params).toHaveProperty("command");
      expect(params).toHaveProperty("text");
      expect(params).toHaveProperty("team_id");
      expect(params).toHaveProperty("user_id");
      expect(params).toHaveProperty("channel_id");
      expect(params).toHaveProperty("response_url");
    });

    it("signature verifies correctly for form-encoded body", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "slack",
        secret: TEST_SECRET,
        template: "slash_command",
      });
      expect(await verifySlackSignature(result.body, result.headers, TEST_SECRET)).toBe(true);
    });
  });

  describe("url_verification template", () => {
    it("has correct url_verification payload", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "slack",
        secret: TEST_SECRET,
        template: "url_verification",
      });
      const body = parseBody(result.body!) as Record<string, unknown>;
      expect(body.type).toBe("url_verification");
      expect(body).toHaveProperty("challenge");
      expect(body).toHaveProperty("token");
    });
  });
});

// ─── Paddle ─────────────────────────────────────────────────────────────

describe("Paddle templates", () => {
  const PADDLE_TEMPLATES = [
    "transaction.completed",
    "subscription.created",
    "subscription.updated",
  ] as const;

  for (const template of PADDLE_TEMPLATES) {
    describe(`template: ${template}`, () => {
      it("produces valid JSON with correct Content-Type", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "paddle",
          secret: TEST_SECRET,
          template,
        });
        expect(result.headers["content-type"]).toBe("application/json");
        expect(() => JSON.parse(result.body!)).not.toThrow();
      });

      it("has correct Paddle event structure", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "paddle",
          secret: TEST_SECRET,
          template,
        });
        const body = parseBody(result.body!) as Record<string, unknown>;

        expect(body).toHaveProperty("event_id");
        expect(typeof body.event_id).toBe("string");

        expect(body).toHaveProperty("event_type");
        expect(body.event_type).toBe(template);

        expect(body).toHaveProperty("occurred_at");
        expect(typeof body.occurred_at).toBe("string");

        expect(body).toHaveProperty("data");
        expect(typeof body.data).toBe("object");

        expect(body).toHaveProperty("notification_id");
      });

      it("has paddle-signature header", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "paddle",
          secret: TEST_SECRET,
          template,
        });
        const sig = getHeader(result.headers, "paddle-signature");
        expect(sig).toBeDefined();
        expect(sig).toMatch(/^ts=\d+;h1=[a-f0-9]+$/);
      });

      it("signature verifies correctly", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "paddle",
          secret: TEST_SECRET,
          template,
        });
        const sig = getHeader(result.headers, "paddle-signature")!;
        expect(await verifyPaddleSignature(result.body, sig, TEST_SECRET)).toBe(true);
        expect(await verifyPaddleSignature(result.body, sig, "wrong_secret")).toBe(false);
      });
    });
  }
});

// ─── Linear ─────────────────────────────────────────────────────────────

describe("Linear templates", () => {
  const LINEAR_TEMPLATES = ["issue.create", "issue.update", "comment.create"] as const;

  for (const template of LINEAR_TEMPLATES) {
    describe(`template: ${template}`, () => {
      it("produces valid JSON with correct Content-Type", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "linear",
          secret: TEST_SECRET,
          template,
        });
        expect(result.headers["content-type"]).toBe("application/json");
        expect(() => JSON.parse(result.body!)).not.toThrow();
      });

      it("has correct Linear event structure", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "linear",
          secret: TEST_SECRET,
          template,
        });
        const body = parseBody(result.body!) as Record<string, unknown>;

        expect(body).toHaveProperty("action");
        expect(typeof body.action).toBe("string");

        expect(body).toHaveProperty("type");
        expect(typeof body.type).toBe("string");

        expect(body).toHaveProperty("data");
        expect(typeof body.data).toBe("object");

        expect(body).toHaveProperty("webhookTimestamp");
        expect(typeof body.webhookTimestamp).toBe("string");
      });

      it("has linear-signature header", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "linear",
          secret: TEST_SECRET,
          template,
        });
        const sig = getHeader(result.headers, "linear-signature");
        expect(sig).toBeDefined();
        expect(sig).toMatch(/^sha256=[a-f0-9]+$/);
      });

      it("signature verifies correctly", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "linear",
          secret: TEST_SECRET,
          template,
        });
        const sig = getHeader(result.headers, "linear-signature")!;
        expect(await verifyLinearSignature(result.body, sig, TEST_SECRET)).toBe(true);
        expect(await verifyLinearSignature(result.body, sig, "wrong_secret")).toBe(false);
      });
    });
  }

  it("issue.create has Issue type", async () => {
    const result = await buildTemplateSendOptions(ENDPOINT_URL, {
      provider: "linear",
      secret: TEST_SECRET,
      template: "issue.create",
    });
    const body = parseBody(result.body!) as Record<string, unknown>;
    expect(body.type).toBe("Issue");
    expect(body.action).toBe("create");
    const data = body.data as Record<string, unknown>;
    expect(data).toHaveProperty("id");
    expect(data).toHaveProperty("identifier");
    expect(data).toHaveProperty("title");
  });

  it("comment.create has Comment type", async () => {
    const result = await buildTemplateSendOptions(ENDPOINT_URL, {
      provider: "linear",
      secret: TEST_SECRET,
      template: "comment.create",
    });
    const body = parseBody(result.body!) as Record<string, unknown>;
    expect(body.type).toBe("Comment");
    expect(body.action).toBe("create");
    const data = body.data as Record<string, unknown>;
    expect(data).toHaveProperty("body");
    expect(data).toHaveProperty("issue");
    expect(data).toHaveProperty("user");
  });
});

// ─── SendGrid ───────────────────────────────────────────────────────────

describe("SendGrid templates", () => {
  const SENDGRID_TEMPLATES = ["delivered", "open", "bounce", "spam_report"] as const;

  for (const template of SENDGRID_TEMPLATES) {
    describe(`template: ${template}`, () => {
      it("produces valid JSON with correct Content-Type", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "sendgrid",
          secret: TEST_SECRET,
          template,
        });
        expect(result.headers["content-type"]).toBe("application/json");
        expect(() => JSON.parse(result.body!)).not.toThrow();
      });

      it("body is a JSON array (not object)", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "sendgrid",
          secret: TEST_SECRET,
          template,
        });
        const body = parseBody(result.body!);
        expect(Array.isArray(body)).toBe(true);
        expect((body as unknown[]).length).toBeGreaterThan(0);
      });

      it("each event has required SendGrid fields", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "sendgrid",
          secret: TEST_SECRET,
          template,
        });
        const events = parseBody(result.body!) as Record<string, unknown>[];
        for (const event of events) {
          expect(event).toHaveProperty("email");
          expect(typeof event.email).toBe("string");

          expect(event).toHaveProperty("timestamp");
          expect(typeof event.timestamp).toBe("number");

          expect(event).toHaveProperty("event");
          expect(typeof event.event).toBe("string");

          expect(event).toHaveProperty("sg_event_id");
          expect(typeof event.sg_event_id).toBe("string");
        }
      });

      it("has NO signature headers (SendGrid is unsigned)", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "sendgrid",
          secret: TEST_SECRET,
          template,
        });
        // SendGrid should not have any signature-related headers
        expect(getHeader(result.headers, "x-twilio-email-event-webhook-signature")).toBeUndefined();
        expect(getHeader(result.headers, "stripe-signature")).toBeUndefined();
        expect(getHeader(result.headers, "x-hub-signature-256")).toBeUndefined();
        expect(getHeader(result.headers, "webhook-signature")).toBeUndefined();
      });
    });
  }
});

// ─── Clerk ──────────────────────────────────────────────────────────────

describe("Clerk templates", () => {
  const CLERK_TEMPLATES = [
    "user.created",
    "user.updated",
    "user.deleted",
    "session.created",
  ] as const;
  const CLERK_SECRET = `whsec_${Buffer.from("clerk-test-secret-key").toString("base64")}`;

  for (const template of CLERK_TEMPLATES) {
    describe(`template: ${template}`, () => {
      it("produces valid JSON with correct Content-Type", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "clerk",
          secret: CLERK_SECRET,
          template,
        });
        expect(result.headers["content-type"]).toBe("application/json");
        expect(() => JSON.parse(result.body!)).not.toThrow();
      });

      it("has correct Clerk event structure", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "clerk",
          secret: CLERK_SECRET,
          template,
        });
        const body = parseBody(result.body!) as Record<string, unknown>;

        expect(body).toHaveProperty("data");
        expect(typeof body.data).toBe("object");

        expect(body.object).toBe("event");

        expect(body).toHaveProperty("type");
        expect(body.type).toBe(template);

        expect(body).toHaveProperty("timestamp");
        expect(typeof body.timestamp).toBe("number");
      });

      it("has both svix-* and webhook-* headers", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "clerk",
          secret: CLERK_SECRET,
          template,
        });

        // Svix headers
        expect(getHeader(result.headers, "svix-id")).toBeDefined();
        expect(getHeader(result.headers, "svix-timestamp")).toBeDefined();
        expect(getHeader(result.headers, "svix-signature")).toBeDefined();

        // Standard Webhook headers
        expect(getHeader(result.headers, "webhook-id")).toBeDefined();
        expect(getHeader(result.headers, "webhook-timestamp")).toBeDefined();
        expect(getHeader(result.headers, "webhook-signature")).toBeDefined();

        // svix and webhook values should match
        expect(getHeader(result.headers, "svix-id")).toBe(getHeader(result.headers, "webhook-id"));
        expect(getHeader(result.headers, "svix-timestamp")).toBe(
          getHeader(result.headers, "webhook-timestamp")
        );
        expect(getHeader(result.headers, "svix-signature")).toBe(
          getHeader(result.headers, "webhook-signature")
        );
      });

      it("signature verifies correctly via verifyClerkSignature", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "clerk",
          secret: CLERK_SECRET,
          template,
        });
        expect(await verifyClerkSignature(result.body, result.headers, CLERK_SECRET)).toBe(true);
        expect(await verifyClerkSignature(result.body, result.headers, "whsec_wrongsecret")).toBe(
          false
        );
      });

      it("signature verifies correctly via verifySignature dispatcher", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "clerk",
          secret: CLERK_SECRET,
          template,
        });
        const verification = await verifySignature(
          { body: result.body, headers: result.headers },
          { provider: "clerk", secret: CLERK_SECRET }
        );
        expect(verification.valid).toBe(true);
      });
    });
  }

  it("user.created data has user object shape", async () => {
    const result = await buildTemplateSendOptions(ENDPOINT_URL, {
      provider: "clerk",
      secret: CLERK_SECRET,
      template: "user.created",
    });
    const body = parseBody(result.body!) as Record<string, unknown>;
    const data = body.data as Record<string, unknown>;
    expect(data.object).toBe("user");
    expect(data).toHaveProperty("id");
    expect(data).toHaveProperty("email_addresses");
    expect(Array.isArray(data.email_addresses)).toBe(true);
    expect(data).toHaveProperty("first_name");
    expect(data).toHaveProperty("last_name");
  });
});

// ─── Discord ────────────────────────────────────────────────────────────

describe("Discord templates", () => {
  describe("interaction_create template", () => {
    it("produces valid JSON with correct Content-Type", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "discord",
        secret: TEST_SECRET,
        template: "interaction_create",
      });
      expect(result.headers["content-type"]).toBe("application/json");
      expect(() => JSON.parse(result.body!)).not.toThrow();
    });

    it("has correct interaction payload shape", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "discord",
        secret: TEST_SECRET,
        template: "interaction_create",
      });
      const body = parseBody(result.body!) as Record<string, unknown>;

      // APPLICATION_COMMAND type is 2
      expect(body.type).toBe(2);

      expect(body).toHaveProperty("application_id");
      expect(body).toHaveProperty("id");

      expect(body).toHaveProperty("data");
      const data = body.data as Record<string, unknown>;
      expect(data).toHaveProperty("name");
    });

    it("has NO signature headers (Discord uses Ed25519, not HMAC)", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "discord",
        secret: TEST_SECRET,
        template: "interaction_create",
      });
      // Discord templates should NOT have HMAC signature headers
      // Discord uses Ed25519 which requires a key pair, not a shared secret
      expect(getHeader(result.headers, "x-signature-ed25519")).toBeUndefined();
      expect(getHeader(result.headers, "stripe-signature")).toBeUndefined();
      expect(getHeader(result.headers, "webhook-signature")).toBeUndefined();

      // But should have x-signature-timestamp for informational purposes
      expect(getHeader(result.headers, "x-signature-timestamp")).toBeDefined();
    });
  });

  describe("ping template", () => {
    it("has type 1 (ping)", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "discord",
        secret: TEST_SECRET,
        template: "ping",
      });
      const body = parseBody(result.body!) as Record<string, unknown>;
      expect(body.type).toBe(1);
      expect(body).toHaveProperty("application_id");
    });
  });

  describe("message_component template", () => {
    it("has type 3 (MESSAGE_COMPONENT)", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "discord",
        secret: TEST_SECRET,
        template: "message_component",
      });
      const body = parseBody(result.body!) as Record<string, unknown>;
      expect(body.type).toBe(3);
      const data = body.data as Record<string, unknown>;
      expect(data).toHaveProperty("custom_id");
      expect(data).toHaveProperty("component_type");
    });
  });
});

// ─── Vercel ─────────────────────────────────────────────────────────────

describe("Vercel templates", () => {
  const VERCEL_TEMPLATES = [
    "deployment.created",
    "deployment.succeeded",
    "deployment.error",
  ] as const;

  for (const template of VERCEL_TEMPLATES) {
    describe(`template: ${template}`, () => {
      it("produces valid JSON with correct Content-Type", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "vercel",
          secret: TEST_SECRET,
          template,
        });
        expect(result.headers["content-type"]).toBe("application/json");
        expect(() => JSON.parse(result.body!)).not.toThrow();
      });

      it("has correct Vercel event structure", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "vercel",
          secret: TEST_SECRET,
          template,
        });
        const body = parseBody(result.body!) as Record<string, unknown>;

        expect(body).toHaveProperty("id");
        expect(typeof body.id).toBe("string");

        expect(body).toHaveProperty("type");
        expect(body.type).toBe(template);

        expect(body).toHaveProperty("createdAt");
        expect(typeof body.createdAt).toBe("number");

        expect(body).toHaveProperty("payload");
        const payload = body.payload as Record<string, unknown>;
        expect(payload).toHaveProperty("deploymentId");
        expect(payload).toHaveProperty("name");
        expect(payload).toHaveProperty("project");
      });

      it("has x-vercel-signature header", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "vercel",
          secret: TEST_SECRET,
          template,
        });
        const sig = getHeader(result.headers, "x-vercel-signature");
        expect(sig).toBeDefined();
        expect(sig).toMatch(/^[a-f0-9]+$/);
      });

      it("signature verifies correctly", async () => {
        const result = await buildTemplateSendOptions(ENDPOINT_URL, {
          provider: "vercel",
          secret: TEST_SECRET,
          template,
        });
        const sig = getHeader(result.headers, "x-vercel-signature")!;
        expect(await verifyVercelSignature(result.body, sig, TEST_SECRET)).toBe(true);
        expect(await verifyVercelSignature(result.body, sig, "wrong_secret")).toBe(false);
      });
    });
  }

  it("deployment.error payload has error details", async () => {
    const result = await buildTemplateSendOptions(ENDPOINT_URL, {
      provider: "vercel",
      secret: TEST_SECRET,
      template: "deployment.error",
    });
    const body = parseBody(result.body!) as Record<string, unknown>;
    const payload = body.payload as Record<string, unknown>;
    expect(payload).toHaveProperty("error");
    const error = payload.error as Record<string, unknown>;
    expect(error).toHaveProperty("message");
    expect(error).toHaveProperty("code");
  });
});

// ─── GitLab ─────────────────────────────────────────────────────────────

describe("GitLab templates", () => {
  describe("push template", () => {
    it("produces valid JSON with correct Content-Type", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "gitlab",
        secret: TEST_SECRET,
        template: "push",
      });
      expect(result.headers["content-type"]).toBe("application/json");
      expect(() => JSON.parse(result.body!)).not.toThrow();
    });

    it("has correct GitLab push payload shape", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "gitlab",
        secret: TEST_SECRET,
        template: "push",
      });
      const body = parseBody(result.body!) as Record<string, unknown>;

      expect(body.object_kind).toBe("push");

      expect(body).toHaveProperty("project");
      const project = body.project as Record<string, unknown>;
      expect(project).toHaveProperty("id");
      expect(project).toHaveProperty("name");
      expect(project).toHaveProperty("web_url");

      expect(body).toHaveProperty("commits");
      expect(Array.isArray(body.commits)).toBe(true);
      expect((body.commits as unknown[]).length).toBeGreaterThan(0);

      expect(body).toHaveProperty("ref");
      expect(body).toHaveProperty("before");
      expect(body).toHaveProperty("after");
      expect(body).toHaveProperty("user_name");
      expect(body).toHaveProperty("total_commits_count");
    });

    it("has x-gitlab-token and x-gitlab-event headers", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "gitlab",
        secret: TEST_SECRET,
        template: "push",
      });
      expect(getHeader(result.headers, "x-gitlab-token")).toBe(TEST_SECRET);
      expect(getHeader(result.headers, "x-gitlab-event")).toBe("Push Hook");
    });

    it("signature verifies correctly (token match)", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "gitlab",
        secret: TEST_SECRET,
        template: "push",
      });
      const token = getHeader(result.headers, "x-gitlab-token")!;
      expect(await verifyGitLabSignature(result.body, token, TEST_SECRET)).toBe(true);
      expect(await verifyGitLabSignature(result.body, token, "wrong_secret")).toBe(false);
    });
  });

  describe("merge_request template", () => {
    it("has correct merge_request payload shape", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "gitlab",
        secret: TEST_SECRET,
        template: "merge_request",
      });
      const body = parseBody(result.body!) as Record<string, unknown>;

      expect(body.object_kind).toBe("merge_request");
      expect(body).toHaveProperty("object_attributes");
      const attrs = body.object_attributes as Record<string, unknown>;
      expect(attrs).toHaveProperty("title");
      expect(attrs).toHaveProperty("state");
      expect(attrs).toHaveProperty("action");
      expect(attrs).toHaveProperty("source_branch");
      expect(attrs).toHaveProperty("target_branch");
    });

    it("has x-gitlab-event set to Merge Request Hook", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "gitlab",
        secret: TEST_SECRET,
        template: "merge_request",
      });
      expect(getHeader(result.headers, "x-gitlab-event")).toBe("Merge Request Hook");
    });

    it("signature verifies correctly", async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "gitlab",
        secret: TEST_SECRET,
        template: "merge_request",
      });
      const token = getHeader(result.headers, "x-gitlab-token")!;
      expect(await verifyGitLabSignature(result.body, token, TEST_SECRET)).toBe(true);
    });
  });
});

// ─── Cross-cutting: verifySignature dispatcher ─────────────────────────

describe("verifySignature dispatcher for all signed providers", () => {
  const CLERK_SECRET = `whsec_${Buffer.from("clerk-test-secret-key").toString("base64")}`;

  const signedProviders = [
    { provider: "stripe" as const, secret: TEST_SECRET },
    { provider: "github" as const, secret: TEST_SECRET },
    { provider: "shopify" as const, secret: TEST_SECRET },
    { provider: "twilio" as const, secret: TEST_SECRET, url: ENDPOINT_URL },
    { provider: "slack" as const, secret: TEST_SECRET },
    { provider: "paddle" as const, secret: TEST_SECRET },
    { provider: "linear" as const, secret: TEST_SECRET },
    { provider: "clerk" as const, secret: CLERK_SECRET },
    { provider: "vercel" as const, secret: TEST_SECRET },
    { provider: "gitlab" as const, secret: TEST_SECRET },
  ] as const;

  for (const providerConfig of signedProviders) {
    it(`verifies ${providerConfig.provider} template via generic dispatcher`, async () => {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider: providerConfig.provider,
        secret: providerConfig.secret,
      });

      const options: Record<string, unknown> = {
        provider: providerConfig.provider,
        secret: providerConfig.secret,
      };
      if ("url" in providerConfig) {
        options.url = providerConfig.url;
      }

      const verification = await verifySignature(
        { body: result.body, headers: result.headers },
        options as Parameters<typeof verifySignature>[1]
      );
      expect(verification.valid).toBe(true);
    });
  }
});

// ─── Cross-cutting: method defaults and template metadata ───────────────

describe("cross-cutting template properties", () => {
  const ALL_PROVIDERS = [
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
  ] as const;

  for (const provider of ALL_PROVIDERS) {
    it(`${provider} defaults to POST method`, async () => {
      const secret =
        provider === "clerk"
          ? `whsec_${Buffer.from("clerk-test").toString("base64")}`
          : TEST_SECRET;
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider,
        secret,
      });
      expect(result.method).toBe("POST");
    });

    it(`${provider} includes x-webhooks-cc-template-provider header`, async () => {
      const secret =
        provider === "clerk"
          ? `whsec_${Buffer.from("clerk-test").toString("base64")}`
          : TEST_SECRET;
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider,
        secret,
      });
      expect(getHeader(result.headers, "x-webhooks-cc-template-provider")).toBe(provider);
    });
  }

  it("unsigned providers (sendgrid, discord) have no HMAC signature headers", async () => {
    for (const provider of ["sendgrid", "discord"] as const) {
      const result = await buildTemplateSendOptions(ENDPOINT_URL, {
        provider,
        secret: TEST_SECRET,
      });
      // These should NOT have any standard signing headers
      expect(getHeader(result.headers, "stripe-signature")).toBeUndefined();
      expect(getHeader(result.headers, "x-hub-signature-256")).toBeUndefined();
      expect(getHeader(result.headers, "x-shopify-hmac-sha256")).toBeUndefined();
      expect(getHeader(result.headers, "x-twilio-signature")).toBeUndefined();
      expect(getHeader(result.headers, "x-slack-signature")).toBeUndefined();
      expect(getHeader(result.headers, "paddle-signature")).toBeUndefined();
      expect(getHeader(result.headers, "linear-signature")).toBeUndefined();
      expect(getHeader(result.headers, "x-vercel-signature")).toBeUndefined();
      expect(getHeader(result.headers, "x-gitlab-token")).toBeUndefined();
    }
  });
});

// ─── Error handling ─────────────────────────────────────────────────────

describe("template error handling", () => {
  it("rejects unsupported template names", async () => {
    await expect(
      buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "stripe",
        secret: TEST_SECRET,
        template: "nonexistent.template",
      })
    ).rejects.toThrow(/Unsupported template/);
  });

  it("rejects unsupported sendgrid template", async () => {
    await expect(
      buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "sendgrid",
        secret: TEST_SECRET,
        template: "nonexistent",
      })
    ).rejects.toThrow(/Unsupported template/);
  });

  it("rejects unsupported discord template", async () => {
    await expect(
      buildTemplateSendOptions(ENDPOINT_URL, {
        provider: "discord",
        secret: TEST_SECRET,
        template: "nonexistent",
      })
    ).rejects.toThrow(/Unsupported template/);
  });
});
