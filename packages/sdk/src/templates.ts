import type { SendOptions, SendTemplateOptions, TemplateProvider } from "./types";

type TwilioParamEntry = [string, string];

const DEFAULT_TEMPLATE_BY_PROVIDER = {
  stripe: "payment_intent.succeeded",
  github: "push",
  shopify: "orders/create",
  twilio: "messaging.inbound",
} as const;

const PROVIDER_TEMPLATES = {
  stripe: ["payment_intent.succeeded", "checkout.session.completed", "invoice.paid"] as const,
  github: ["push", "pull_request.opened", "ping"] as const,
  shopify: ["orders/create", "orders/paid", "products/update", "app/uninstalled"] as const,
  twilio: ["messaging.inbound", "messaging.status_callback", "voice.incoming_call"] as const,
} as const;

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

function randomToken(prefix: string): string {
  return `${prefix}_${randomHex(8)}`;
}

function randomDigits(length: number): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 10).toString()).join("");
}

function randomSid(prefix: "SM" | "AC" | "CA"): string {
  return `${prefix}${randomHex(32)}`;
}

function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}`;
}

function repositoryPayload() {
  return {
    id: Number(randomDigits(9)),
    name: "demo-repo",
    full_name: "webhooks-cc/demo-repo",
    private: false,
    default_branch: "main",
    html_url: "https://github.com/webhooks-cc/demo-repo",
  };
}

function githubSender() {
  return {
    login: "webhooks-cc-bot",
    id: 987654,
    type: "Bot",
  };
}

function ensureTemplate(provider: TemplateProvider, template?: string): string {
  const resolved = template ?? DEFAULT_TEMPLATE_BY_PROVIDER[provider];
  const supported = PROVIDER_TEMPLATES[provider];
  if (!supported.some((item) => item === resolved)) {
    throw new Error(
      `Unsupported template "${resolved}" for provider "${provider}". Supported templates: ${supported.join(", ")}`
    );
  }
  return resolved;
}

function defaultEvent(provider: TemplateProvider, template: string): string {
  if (provider === "github" && template === "pull_request.opened") {
    return "pull_request";
  }
  return template;
}

function formEncode(params: Record<string, string>): string {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    form.append(key, value);
  }
  return form.toString();
}

function asStringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v == null) {
      out[k] = "";
      continue;
    }
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

function buildTemplatePayload(
  provider: TemplateProvider,
  template: string,
  event: string,
  now: Date,
  bodyOverride: SendTemplateOptions["body"]
): {
  body: string;
  contentType: string;
  headers: Record<string, string>;
  twilioParams?: TwilioParamEntry[];
} {
  const nowSec = Math.floor(now.getTime() / 1000);
  const nowIso = now.toISOString();

  if (provider === "stripe") {
    const paymentIntentId = randomToken("pi");
    const checkoutSessionId = `cs_test_${randomHex(24)}`;

    const payloadByTemplate: Record<string, unknown> = {
      "payment_intent.succeeded": {
        id: randomToken("evt"),
        object: "event",
        api_version: "2025-01-27.acacia",
        created: nowSec,
        data: {
          object: {
            id: paymentIntentId,
            object: "payment_intent",
            amount: 2000,
            amount_received: 2000,
            currency: "usd",
            status: "succeeded",
            created: nowSec,
            metadata: {
              order_id: randomToken("order"),
            },
          },
        },
        livemode: false,
        pending_webhooks: 1,
        request: {
          id: `req_${randomHex(24)}`,
          idempotency_key: null,
        },
        type: event,
      },
      "checkout.session.completed": {
        id: randomToken("evt"),
        object: "event",
        api_version: "2025-01-27.acacia",
        created: nowSec,
        data: {
          object: {
            id: checkoutSessionId,
            object: "checkout.session",
            mode: "payment",
            payment_status: "paid",
            amount_total: 2000,
            amount_subtotal: 2000,
            currency: "usd",
            customer: `cus_${randomHex(14)}`,
            payment_intent: paymentIntentId,
            status: "complete",
            success_url: "https://example.com/success",
            cancel_url: "https://example.com/cancel",
            created: nowSec,
          },
        },
        livemode: false,
        pending_webhooks: 1,
        request: {
          id: `req_${randomHex(24)}`,
          idempotency_key: null,
        },
        type: event,
      },
      "invoice.paid": {
        id: randomToken("evt"),
        object: "event",
        api_version: "2025-01-27.acacia",
        created: nowSec,
        data: {
          object: {
            id: `in_${randomHex(14)}`,
            object: "invoice",
            account_country: "US",
            account_name: "webhooks.cc demo",
            amount_due: 2000,
            amount_paid: 2000,
            amount_remaining: 0,
            billing_reason: "subscription_cycle",
            currency: "usd",
            customer: `cus_${randomHex(14)}`,
            paid: true,
            status: "paid",
            hosted_invoice_url: "https://invoice.stripe.com/demo",
            created: nowSec,
          },
        },
        livemode: false,
        pending_webhooks: 1,
        request: {
          id: `req_${randomHex(24)}`,
          idempotency_key: null,
        },
        type: event,
      },
    };

    const payload = bodyOverride ?? payloadByTemplate[template];
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    return {
      body,
      contentType: "application/json",
      headers: {
        "user-agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks)",
      },
    };
  }

  if (provider === "github") {
    const before = randomHex(40);
    const after = randomHex(40);
    const baseRepo = repositoryPayload();

    const payloadByTemplate: Record<string, unknown> = {
      push: {
        ref: "refs/heads/main",
        before,
        after,
        repository: baseRepo,
        pusher: {
          name: "webhooks-cc-bot",
          email: "bot@webhooks.cc",
        },
        sender: githubSender(),
        created: false,
        deleted: false,
        forced: false,
        compare: `https://github.com/${baseRepo.full_name}/compare/${before}...${after}`,
        commits: [
          {
            id: after,
            message: "Update webhook integration tests",
            timestamp: nowIso,
            url: `https://github.com/${baseRepo.full_name}/commit/${after}`,
            author: {
              name: "webhooks-cc-bot",
              email: "bot@webhooks.cc",
            },
            committer: {
              name: "webhooks-cc-bot",
              email: "bot@webhooks.cc",
            },
            added: [],
            removed: [],
            modified: ["src/webhooks.ts"],
          },
        ],
        head_commit: {
          id: after,
          message: "Update webhook integration tests",
          timestamp: nowIso,
          url: `https://github.com/${baseRepo.full_name}/commit/${after}`,
          author: {
            name: "webhooks-cc-bot",
            email: "bot@webhooks.cc",
          },
          committer: {
            name: "webhooks-cc-bot",
            email: "bot@webhooks.cc",
          },
          added: [],
          removed: [],
          modified: ["src/webhooks.ts"],
        },
      },
      "pull_request.opened": {
        action: "opened",
        number: 42,
        pull_request: {
          id: Number(randomDigits(9)),
          number: 42,
          state: "open",
          title: "Add webhook retry logic",
          body: "This PR improves retry handling for inbound webhooks.",
          created_at: nowIso,
          updated_at: nowIso,
          html_url: `https://github.com/${baseRepo.full_name}/pull/42`,
          user: {
            login: "webhooks-cc-bot",
            id: 987654,
            type: "Bot",
          },
          draft: false,
          head: {
            label: "webhooks-cc:feature/webhook-retries",
            ref: "feature/webhook-retries",
            sha: randomHex(40),
            repo: baseRepo,
          },
          base: {
            label: "webhooks-cc:main",
            ref: "main",
            sha: randomHex(40),
            repo: baseRepo,
          },
        },
        repository: baseRepo,
        sender: githubSender(),
      },
      ping: {
        zen: "Keep it logically awesome.",
        hook_id: Number(randomDigits(7)),
        hook: {
          type: "Repository",
          id: Number(randomDigits(7)),
          name: "web",
          active: true,
          events: ["push", "pull_request"],
          config: {
            content_type: "json",
            insecure_ssl: "0",
            url: "https://go.webhooks.cc/w/demo",
          },
        },
        repository: baseRepo,
        sender: githubSender(),
      },
    };

    const payload = bodyOverride ?? payloadByTemplate[template];
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    return {
      body,
      contentType: "application/json",
      headers: {
        "user-agent": "GitHub-Hookshot/8f03f6d",
      },
    };
  }

  if (provider === "shopify") {
    const payloadByTemplate: Record<string, unknown> = {
      "orders/create": {
        id: Number(randomDigits(10)),
        admin_graphql_api_id: `gid://shopify/Order/${randomDigits(10)}`,
        email: "customer@example.com",
        created_at: nowIso,
        updated_at: nowIso,
        currency: "USD",
        financial_status: "pending",
        fulfillment_status: null,
        total_price: "19.99",
        subtotal_price: "19.99",
        total_tax: "0.00",
        line_items: [
          {
            id: Number(randomDigits(10)),
            admin_graphql_api_id: `gid://shopify/LineItem/${randomDigits(10)}`,
            title: "Demo Item",
            quantity: 1,
            sku: "DEMO-001",
            price: "19.99",
          },
        ],
      },
      "orders/paid": {
        id: Number(randomDigits(10)),
        admin_graphql_api_id: `gid://shopify/Order/${randomDigits(10)}`,
        email: "customer@example.com",
        created_at: nowIso,
        updated_at: nowIso,
        currency: "USD",
        financial_status: "paid",
        fulfillment_status: null,
        total_price: "49.00",
        subtotal_price: "49.00",
        total_tax: "0.00",
        line_items: [
          {
            id: Number(randomDigits(10)),
            admin_graphql_api_id: `gid://shopify/LineItem/${randomDigits(10)}`,
            title: "Webhook Pro Plan",
            quantity: 1,
            sku: "WHK-PRO",
            price: "49.00",
          },
        ],
      },
      "products/update": {
        id: Number(randomDigits(10)),
        admin_graphql_api_id: `gid://shopify/Product/${randomDigits(10)}`,
        title: "Webhook Tester Hoodie",
        body_html: "<strong>Updated product details</strong>",
        vendor: "webhooks.cc",
        product_type: "Apparel",
        handle: "webhook-tester-hoodie",
        status: "active",
        created_at: nowIso,
        updated_at: nowIso,
        variants: [
          {
            id: Number(randomDigits(10)),
            product_id: Number(randomDigits(10)),
            title: "Default Title",
            price: "39.00",
            sku: "WHK-HOODIE",
            position: 1,
            inventory_policy: "deny",
            fulfillment_service: "manual",
            inventory_management: "shopify",
          },
        ],
      },
      "app/uninstalled": {
        id: Number(randomDigits(10)),
        name: "Demo Shop",
        email: "owner@example.com",
        domain: "demo-shop.myshopify.com",
        myshopify_domain: "demo-shop.myshopify.com",
        country_name: "United States",
        currency: "USD",
        plan_name: "basic",
        created_at: nowIso,
        updated_at: nowIso,
      },
    };

    const payload = bodyOverride ?? payloadByTemplate[template];
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    return {
      body,
      contentType: "application/json",
      headers: {
        "x-shopify-shop-domain": "demo-shop.myshopify.com",
        "x-shopify-api-version": "2025-10",
        "x-shopify-webhook-id": randomUuid(),
        "x-shopify-event-id": randomUuid(),
        "x-shopify-triggered-at": nowIso,
      },
    };
  }

  if (provider !== "twilio") {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  const defaultTwilioParamsByTemplate: Record<string, Record<string, string>> = {
    "messaging.inbound": {
      AccountSid: randomSid("AC"),
      ApiVersion: "2010-04-01",
      MessageSid: randomSid("SM"),
      SmsSid: randomSid("SM"),
      SmsMessageSid: randomSid("SM"),
      From: "+14155550123",
      To: "+14155559876",
      Body: "Hello from webhooks.cc",
      NumMedia: "0",
      NumSegments: "1",
      MessageStatus: "received",
      SmsStatus: "received",
      FromCity: "SAN FRANCISCO",
      FromState: "CA",
      FromCountry: "US",
      FromZip: "94105",
      ToCity: "",
      ToState: "",
      ToCountry: "US",
      ToZip: "",
    },
    "messaging.status_callback": {
      AccountSid: randomSid("AC"),
      ApiVersion: "2010-04-01",
      MessageSid: randomSid("SM"),
      SmsSid: randomSid("SM"),
      MessageStatus: "delivered",
      SmsStatus: "delivered",
      To: "+14155559876",
      From: "+14155550123",
      ErrorCode: "",
    },
    "voice.incoming_call": {
      AccountSid: randomSid("AC"),
      ApiVersion: "2010-04-01",
      CallSid: randomSid("CA"),
      CallStatus: "ringing",
      Direction: "inbound",
      From: "+14155550123",
      To: "+14155559876",
      CallerCity: "SAN FRANCISCO",
      CallerState: "CA",
      CallerCountry: "US",
      CallerZip: "94105",
      CalledCity: "",
      CalledState: "",
      CalledCountry: "US",
      CalledZip: "",
    },
  };

  let twilioParams: Record<string, string>;
  if (bodyOverride !== undefined) {
    if (typeof bodyOverride === "string") {
      const entries = Array.from(new URLSearchParams(bodyOverride).entries());
      return {
        body: bodyOverride,
        contentType: "application/x-www-form-urlencoded",
        headers: {
          "user-agent": "TwilioProxy/1.1",
        },
        twilioParams: entries,
      };
    }
    const overrideParams = asStringRecord(bodyOverride);
    if (!overrideParams) {
      throw new Error("Twilio template body override must be a string or an object");
    }
    twilioParams = overrideParams;
  } else {
    twilioParams = defaultTwilioParamsByTemplate[template];
  }

  return {
    body: formEncode(twilioParams),
    contentType: "application/x-www-form-urlencoded",
    headers: {
      "user-agent": "TwilioProxy/1.1",
    },
    twilioParams: Object.entries(twilioParams),
  };
}

async function hmacSign(
  algorithm: "SHA-256" | "SHA-1",
  secret: string,
  payload: string
): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("crypto.subtle is required for template signature generation");
  }
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"]
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  return new Uint8Array(signature);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function buildTwilioSignaturePayload(endpointUrl: string, params: TwilioParamEntry[]): string {
  const sortedParams = params
    .map(([key, value], index) => ({ key, value, index }))
    .sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0
    );
  let payload = endpointUrl;
  for (const { key, value } of sortedParams) {
    payload += `${key}${value}`;
  }
  return payload;
}

/**
 * Build method/headers/body for a provider template webhook.
 */
export async function buildTemplateSendOptions(
  endpointUrl: string,
  options: SendTemplateOptions
): Promise<SendOptions> {
  const method = (options.method ?? "POST").toUpperCase();
  const template = ensureTemplate(options.provider, options.template);
  const event = options.event ?? defaultEvent(options.provider, template);
  const now = new Date();

  const built = buildTemplatePayload(options.provider, template, event, now, options.body);

  const headers: Record<string, string> = {
    "content-type": built.contentType,
    "x-webhooks-cc-template-provider": options.provider,
    "x-webhooks-cc-template-template": template,
    "x-webhooks-cc-template-event": event,
    ...built.headers,
  };

  if (options.provider === "stripe") {
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const signature = await hmacSign("SHA-256", options.secret, `${timestamp}.${built.body}`);
    headers["stripe-signature"] = `t=${timestamp},v1=${toHex(signature)}`;
  }

  if (options.provider === "github") {
    headers["x-github-event"] = event;
    headers["x-github-delivery"] = randomUuid();
    const signature = await hmacSign("SHA-256", options.secret, built.body);
    headers["x-hub-signature-256"] = `sha256=${toHex(signature)}`;
  }

  if (options.provider === "shopify") {
    headers["x-shopify-topic"] = event;
    const signature = await hmacSign("SHA-256", options.secret, built.body);
    headers["x-shopify-hmac-sha256"] = toBase64(signature);
  }

  if (options.provider === "twilio") {
    const signaturePayload = built.twilioParams
      ? buildTwilioSignaturePayload(endpointUrl, built.twilioParams)
      : `${endpointUrl}${built.body}`;
    const signature = await hmacSign("SHA-1", options.secret, signaturePayload);
    headers["x-twilio-signature"] = toBase64(signature);
  }

  return {
    method,
    headers: {
      ...headers,
      ...(options.headers ?? {}),
    },
    body: built.body,
  };
}
