import type {
  SendOptions,
  SendTemplateOptions,
  TemplateProvider,
  TemplateProviderInfo,
} from "./types";

type TwilioParamEntry = [string, string];
type SignedTemplateProvider = Exclude<
  TemplateProvider,
  "standard-webhooks" | "sendgrid" | "discord"
>;

const DEFAULT_TEMPLATE_BY_PROVIDER = {
  stripe: "payment_intent.succeeded",
  github: "push",
  shopify: "orders/create",
  twilio: "messaging.inbound",
  slack: "event_callback",
  paddle: "transaction.completed",
  linear: "issue.create",
  sendgrid: "delivered",
  clerk: "user.created",
  discord: "interaction_create",
  vercel: "deployment.created",
  gitlab: "push",
} as const;

const PROVIDER_TEMPLATES = {
  stripe: ["payment_intent.succeeded", "checkout.session.completed", "invoice.paid"] as const,
  github: ["push", "pull_request.opened", "ping"] as const,
  shopify: ["orders/create", "orders/paid", "products/update", "app/uninstalled"] as const,
  twilio: ["messaging.inbound", "messaging.status_callback", "voice.incoming_call"] as const,
  slack: ["event_callback", "slash_command", "url_verification"] as const,
  paddle: ["transaction.completed", "subscription.created", "subscription.updated"] as const,
  linear: ["issue.create", "issue.update", "comment.create"] as const,
  sendgrid: ["delivered", "open", "bounce", "spam_report"] as const,
  clerk: ["user.created", "user.updated", "user.deleted", "session.created"] as const,
  discord: ["interaction_create", "message_component", "ping"] as const,
  vercel: ["deployment.created", "deployment.succeeded", "deployment.error"] as const,
  gitlab: ["push", "merge_request"] as const,
} as const;

export const TEMPLATE_PROVIDERS = [
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
] as const satisfies readonly TemplateProvider[];

export const TEMPLATE_METADATA = Object.freeze({
  stripe: Object.freeze({
    provider: "stripe",
    templates: Object.freeze([...PROVIDER_TEMPLATES.stripe]),
    defaultTemplate: DEFAULT_TEMPLATE_BY_PROVIDER.stripe,
    secretRequired: true,
    signatureHeader: "stripe-signature",
    signatureAlgorithm: "hmac-sha256",
  }),
  github: Object.freeze({
    provider: "github",
    templates: Object.freeze([...PROVIDER_TEMPLATES.github]),
    defaultTemplate: DEFAULT_TEMPLATE_BY_PROVIDER.github,
    secretRequired: true,
    signatureHeader: "x-hub-signature-256",
    signatureAlgorithm: "hmac-sha256",
  }),
  shopify: Object.freeze({
    provider: "shopify",
    templates: Object.freeze([...PROVIDER_TEMPLATES.shopify]),
    defaultTemplate: DEFAULT_TEMPLATE_BY_PROVIDER.shopify,
    secretRequired: true,
    signatureHeader: "x-shopify-hmac-sha256",
    signatureAlgorithm: "hmac-sha256",
  }),
  twilio: Object.freeze({
    provider: "twilio",
    templates: Object.freeze([...PROVIDER_TEMPLATES.twilio]),
    defaultTemplate: DEFAULT_TEMPLATE_BY_PROVIDER.twilio,
    secretRequired: true,
    signatureHeader: "x-twilio-signature",
    signatureAlgorithm: "hmac-sha1",
  }),
  slack: Object.freeze({
    provider: "slack",
    templates: Object.freeze([...PROVIDER_TEMPLATES.slack]),
    defaultTemplate: DEFAULT_TEMPLATE_BY_PROVIDER.slack,
    secretRequired: true,
    signatureHeader: "x-slack-signature",
    signatureAlgorithm: "hmac-sha256",
  }),
  paddle: Object.freeze({
    provider: "paddle",
    templates: Object.freeze([...PROVIDER_TEMPLATES.paddle]),
    defaultTemplate: DEFAULT_TEMPLATE_BY_PROVIDER.paddle,
    secretRequired: true,
    signatureHeader: "paddle-signature",
    signatureAlgorithm: "hmac-sha256",
  }),
  linear: Object.freeze({
    provider: "linear",
    templates: Object.freeze([...PROVIDER_TEMPLATES.linear]),
    defaultTemplate: DEFAULT_TEMPLATE_BY_PROVIDER.linear,
    secretRequired: true,
    signatureHeader: "linear-signature",
    signatureAlgorithm: "hmac-sha256",
  }),
  sendgrid: Object.freeze({
    provider: "sendgrid",
    templates: Object.freeze([...PROVIDER_TEMPLATES.sendgrid]),
    defaultTemplate: DEFAULT_TEMPLATE_BY_PROVIDER.sendgrid,
    secretRequired: false,
  }),
  clerk: Object.freeze({
    provider: "clerk",
    templates: Object.freeze([...PROVIDER_TEMPLATES.clerk]),
    defaultTemplate: DEFAULT_TEMPLATE_BY_PROVIDER.clerk,
    secretRequired: true,
    signatureHeader: "webhook-signature",
    signatureAlgorithm: "hmac-sha256",
  }),
  discord: Object.freeze({
    provider: "discord",
    templates: Object.freeze([...PROVIDER_TEMPLATES.discord]),
    defaultTemplate: DEFAULT_TEMPLATE_BY_PROVIDER.discord,
    secretRequired: false,
  }),
  vercel: Object.freeze({
    provider: "vercel",
    templates: Object.freeze([...PROVIDER_TEMPLATES.vercel]),
    defaultTemplate: DEFAULT_TEMPLATE_BY_PROVIDER.vercel,
    secretRequired: true,
    signatureHeader: "x-vercel-signature",
    signatureAlgorithm: "hmac-sha1",
  }),
  gitlab: Object.freeze({
    provider: "gitlab",
    templates: Object.freeze([...PROVIDER_TEMPLATES.gitlab]),
    defaultTemplate: DEFAULT_TEMPLATE_BY_PROVIDER.gitlab,
    secretRequired: true,
    signatureHeader: "x-gitlab-token",
    signatureAlgorithm: "token",
  }),
  "standard-webhooks": Object.freeze({
    provider: "standard-webhooks",
    templates: Object.freeze([]),
    secretRequired: true,
    signatureHeader: "webhook-signature",
    signatureAlgorithm: "hmac-sha256",
  }),
}) satisfies Readonly<Record<TemplateProvider, TemplateProviderInfo>>;

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

function ensureTemplate(provider: SignedTemplateProvider, template?: string): string {
  const resolved = template ?? DEFAULT_TEMPLATE_BY_PROVIDER[provider];
  const supported = PROVIDER_TEMPLATES[provider];
  if (!supported.some((item) => item === resolved)) {
    throw new Error(
      `Unsupported template "${resolved}" for provider "${provider}". Supported templates: ${supported.join(", ")}`
    );
  }
  return resolved;
}

function defaultEvent(provider: SignedTemplateProvider, template: string): string {
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
  provider: SignedTemplateProvider,
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
    if (provider === "slack") {
      const eventCallbackPayload = {
        token: randomHex(24),
        team_id: `T${randomHex(8).toUpperCase()}`,
        api_app_id: `A${randomHex(8).toUpperCase()}`,
        type: "event_callback",
        event: {
          type: "app_mention",
          user: `U${randomHex(8).toUpperCase()}`,
          text: "hello from webhooks.cc",
          ts: `${nowSec}.000100`,
          channel: `C${randomHex(8).toUpperCase()}`,
          event_ts: `${nowSec}.000100`,
        },
        event_id: `Ev${randomHex(12)}`,
        event_time: nowSec,
        authed_users: [`U${randomHex(8).toUpperCase()}`],
      };
      const verificationPayload = {
        token: randomHex(24),
        challenge: randomHex(16),
        type: "url_verification",
      };
      const defaultSlashCommand = {
        token: randomHex(24),
        team_id: `T${randomHex(8).toUpperCase()}`,
        team_domain: "webhooks-cc",
        channel_id: `C${randomHex(8).toUpperCase()}`,
        channel_name: "general",
        user_id: `U${randomHex(8).toUpperCase()}`,
        user_name: "webhooks-bot",
        command: "/webhook-test",
        text: "hello world",
        response_url: "https://hooks.slack.com/commands/demo",
        trigger_id: randomHex(12),
      };

      if (template === "slash_command") {
        let body: string;
        if (bodyOverride === undefined) {
          body = formEncode(defaultSlashCommand);
        } else if (typeof bodyOverride === "string") {
          body = bodyOverride;
        } else {
          const params = asStringRecord(bodyOverride);
          if (!params) {
            throw new Error("Slack slash_command body override must be a string or an object");
          }
          body = formEncode(params);
        }

        return {
          body,
          contentType: "application/x-www-form-urlencoded",
          headers: {
            "user-agent": "Slackbot 1.0 (+https://api.slack.com/robots)",
          },
        };
      }

      const payload =
        bodyOverride ??
        (template === "url_verification" ? verificationPayload : eventCallbackPayload);
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      return {
        body,
        contentType: "application/json",
        headers: {
          "user-agent": "Slackbot 1.0 (+https://api.slack.com/robots)",
        },
      };
    }

    if (provider === "paddle") {
      const payloadByTemplate: Record<string, unknown> = {
        "transaction.completed": {
          event_id: randomUuid(),
          event_type: "transaction.completed",
          occurred_at: nowIso,
          notification_id: randomUuid(),
          data: {
            id: `txn_${randomHex(12)}`,
            status: "completed",
            customer_id: `ctm_${randomHex(12)}`,
            currency_code: "USD",
            total: "49.00",
          },
        },
        "subscription.created": {
          event_id: randomUuid(),
          event_type: "subscription.created",
          occurred_at: nowIso,
          notification_id: randomUuid(),
          data: {
            id: `sub_${randomHex(12)}`,
            status: "active",
            customer_id: `ctm_${randomHex(12)}`,
            next_billed_at: nowIso,
          },
        },
        "subscription.updated": {
          event_id: randomUuid(),
          event_type: "subscription.updated",
          occurred_at: nowIso,
          notification_id: randomUuid(),
          data: {
            id: `sub_${randomHex(12)}`,
            status: "past_due",
            customer_id: `ctm_${randomHex(12)}`,
            next_billed_at: nowIso,
          },
        },
      };

      const payload = bodyOverride ?? payloadByTemplate[template];
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      return {
        body,
        contentType: "application/json",
        headers: {
          "user-agent": "Paddle/1.0",
        },
      };
    }

    if (provider === "linear") {
      const issueId = randomUuid();
      const payloadByTemplate: Record<string, unknown> = {
        "issue.create": {
          action: "create",
          type: "Issue",
          webhookTimestamp: nowIso,
          data: {
            id: issueId,
            identifier: "ENG-42",
            title: "Investigate webhook retry regression",
            description: "Created from the webhooks.cc Linear template",
            url: `https://linear.app/webhooks-cc/issue/ENG-42/${issueId}`,
          },
        },
        "issue.update": {
          action: "update",
          type: "Issue",
          webhookTimestamp: nowIso,
          data: {
            id: issueId,
            identifier: "ENG-42",
            title: "Investigate webhook retry regression",
            state: {
              name: "In Progress",
            },
            url: `https://linear.app/webhooks-cc/issue/ENG-42/${issueId}`,
          },
        },
        "comment.create": {
          action: "create",
          type: "Comment",
          webhookTimestamp: nowIso,
          data: {
            id: randomUuid(),
            body: "Looks good from the webhook sandbox.",
            issue: {
              id: issueId,
              identifier: "ENG-42",
              title: "Investigate webhook retry regression",
            },
            user: {
              id: randomUuid(),
              name: "webhooks.cc bot",
            },
          },
        },
      };

      const payload = bodyOverride ?? payloadByTemplate[template];
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      return {
        body,
        contentType: "application/json",
        headers: {
          "user-agent": "Linear/1.0",
        },
      };
    }

    if (provider === "clerk") {
      const userId = `user_${randomHex(24)}`;
      const payloadByTemplate: Record<string, unknown> = {
        "user.created": {
          data: {
            id: userId,
            object: "user",
            email_addresses: [
              {
                id: `idn_${randomHex(24)}`,
                email_address: "user@example.com",
                verification: { status: "verified", strategy: "email_code" },
              },
            ],
            first_name: "Jane",
            last_name: "Doe",
            created_at: nowSec * 1000,
            updated_at: nowSec * 1000,
          },
          object: "event",
          type: "user.created",
          timestamp: nowSec * 1000,
        },
        "user.updated": {
          data: {
            id: userId,
            object: "user",
            email_addresses: [
              {
                id: `idn_${randomHex(24)}`,
                email_address: "user@example.com",
                verification: { status: "verified", strategy: "email_code" },
              },
            ],
            first_name: "Jane",
            last_name: "Smith",
            created_at: nowSec * 1000,
            updated_at: nowSec * 1000,
          },
          object: "event",
          type: "user.updated",
          timestamp: nowSec * 1000,
        },
        "user.deleted": {
          data: {
            id: userId,
            object: "user",
            deleted: true,
          },
          object: "event",
          type: "user.deleted",
          timestamp: nowSec * 1000,
        },
        "session.created": {
          data: {
            id: `sess_${randomHex(24)}`,
            object: "session",
            user_id: userId,
            status: "active",
            created_at: nowSec * 1000,
            updated_at: nowSec * 1000,
            expire_at: (nowSec + 86400) * 1000,
          },
          object: "event",
          type: "session.created",
          timestamp: nowSec * 1000,
        },
      };

      const payload = bodyOverride ?? payloadByTemplate[template];
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      return {
        body,
        contentType: "application/json",
        headers: {
          "user-agent": "Svix-Webhooks/1.0",
        },
      };
    }

    if (provider === "vercel") {
      const deploymentId = `dpl_${randomHex(20)}`;
      const projectId = `prj_${randomHex(20)}`;
      const teamId = `team_${randomHex(20)}`;
      const payloadByTemplate: Record<string, unknown> = {
        "deployment.created": {
          id: randomUuid(),
          type: "deployment.created",
          createdAt: nowSec * 1000,
          payload: {
            deployment: {
              id: deploymentId,
              name: "webhooks-cc-web",
              url: `webhooks-cc-web-${randomHex(8)}.vercel.app`,
              meta: {
                githubCommitRef: "main",
                githubCommitSha: randomHex(40),
                githubCommitMessage: "Update webhook templates",
              },
            },
            project: { id: projectId, name: "webhooks-cc-web" },
            team: { id: teamId, name: "webhooks-cc" },
          },
        },
        "deployment.succeeded": {
          id: randomUuid(),
          type: "deployment.succeeded",
          createdAt: nowSec * 1000,
          payload: {
            deployment: {
              id: deploymentId,
              name: "webhooks-cc-web",
              url: `webhooks-cc-web-${randomHex(8)}.vercel.app`,
              readyState: "READY",
            },
            project: { id: projectId, name: "webhooks-cc-web" },
            team: { id: teamId, name: "webhooks-cc" },
          },
        },
        "deployment.error": {
          id: randomUuid(),
          type: "deployment.error",
          createdAt: nowSec * 1000,
          payload: {
            deployment: {
              id: deploymentId,
              name: "webhooks-cc-web",
              url: `webhooks-cc-web-${randomHex(8)}.vercel.app`,
              readyState: "ERROR",
              errorMessage: "Build failed: exit code 1",
            },
            project: { id: projectId, name: "webhooks-cc-web" },
            team: { id: teamId, name: "webhooks-cc" },
          },
        },
      };

      const payload = bodyOverride ?? payloadByTemplate[template];
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      return {
        body,
        contentType: "application/json",
        headers: {
          "user-agent": "Vercel/1.0",
        },
      };
    }

    if (provider === "gitlab") {
      const projectId = Number(randomDigits(7));
      const payloadByTemplate: Record<string, unknown> = {
        push: {
          object_kind: "push",
          event_name: "push",
          before: randomHex(40),
          after: randomHex(40),
          ref: "refs/heads/main",
          checkout_sha: randomHex(40),
          user_id: Number(randomDigits(5)),
          user_name: "webhooks-cc-bot",
          user_email: "bot@webhooks.cc",
          project_id: projectId,
          project: {
            id: projectId,
            name: "demo-repo",
            web_url: "https://gitlab.com/webhooks-cc/demo-repo",
            namespace: "webhooks-cc",
            default_branch: "main",
          },
          commits: [
            {
              id: randomHex(40),
              message: "Update webhook integration tests",
              title: "Update webhook integration tests",
              timestamp: nowIso,
              url: `https://gitlab.com/webhooks-cc/demo-repo/-/commit/${randomHex(40)}`,
              author: { name: "webhooks-cc-bot", email: "bot@webhooks.cc" },
              added: [],
              modified: ["src/webhooks.ts"],
              removed: [],
            },
          ],
          total_commits_count: 1,
        },
        merge_request: {
          object_kind: "merge_request",
          event_type: "merge_request",
          user: {
            id: Number(randomDigits(5)),
            name: "webhooks-cc-bot",
            username: "webhooks-cc-bot",
            email: "bot@webhooks.cc",
          },
          project: {
            id: projectId,
            name: "demo-repo",
            web_url: "https://gitlab.com/webhooks-cc/demo-repo",
            namespace: "webhooks-cc",
            default_branch: "main",
          },
          object_attributes: {
            id: Number(randomDigits(7)),
            iid: 42,
            title: "Add webhook retry logic",
            description: "This MR improves retry handling for inbound webhooks.",
            state: "opened",
            action: "open",
            source_branch: "feature/webhook-retries",
            target_branch: "main",
            created_at: nowIso,
            updated_at: nowIso,
            url: `https://gitlab.com/webhooks-cc/demo-repo/-/merge_requests/42`,
          },
        },
      };

      const payload = bodyOverride ?? payloadByTemplate[template];
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      return {
        body,
        contentType: "application/json",
        headers: {
          "x-gitlab-event": template === "merge_request" ? "Merge Request Hook" : "Push Hook",
          "user-agent": "GitLab/1.0",
        },
      };
    }

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

export async function hmacSign(
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

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function toBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(str: string): Uint8Array {
  if (typeof atob !== "function") {
    return new Uint8Array(Buffer.from(str, "base64"));
  }
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function hmacSignRaw(
  algorithm: "SHA-256" | "SHA-1",
  keyBytes: Uint8Array,
  payload: string
): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("crypto.subtle is required for signature generation");
  }
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
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

export function buildTwilioSignaturePayload(
  endpointUrl: string,
  params: TwilioParamEntry[]
): string {
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

export function decodeStandardWebhookSecret(secret: string): Uint8Array {
  let rawSecret = secret;
  const hadPrefix = rawSecret.startsWith("whsec_");
  if (hadPrefix) {
    rawSecret = rawSecret.slice(6);
  }

  try {
    return fromBase64(rawSecret);
  } catch {
    const raw = hadPrefix ? secret : rawSecret;
    return new TextEncoder().encode(raw);
  }
}

/**
 * Build method/headers/body for a provider template webhook.
 */
export async function buildTemplateSendOptions(
  endpointUrl: string,
  options: SendTemplateOptions
): Promise<SendOptions> {
  // Standard Webhooks uses a different signing flow — no predefined templates
  if (options.provider === "standard-webhooks") {
    const method = (options.method ?? "POST").toUpperCase();
    const payload = options.body ?? {};
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);

    const msgId = options.event ? `msg_${options.event}_${randomHex(8)}` : `msg_${randomHex(16)}`;
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const signingInput = `${msgId}.${timestamp}.${body}`;

    // Standard Webhooks secrets: strip whsec_ prefix, then try base64 decode.
    // If the remainder isn't valid base64 (e.g. Polar.sh raw secrets), fall back
    // to treating the original secret (with prefix) as raw UTF-8 bytes. This
    // matches how Polar's SDK passes secrets to the standardwebhooks library.
    const secretBytes = decodeStandardWebhookSecret(options.secret);
    const signature = await hmacSignRaw("SHA-256", secretBytes, signingInput);

    return {
      method,
      headers: {
        "content-type": "application/json",
        "webhook-id": msgId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": `v1,${toBase64(signature)}`,
        ...(options.headers ?? {}),
      },
      body,
    };
  }

  // SendGrid — unsigned provider with template payloads
  if (options.provider === "sendgrid") {
    const method = (options.method ?? "POST").toUpperCase();
    const supported = PROVIDER_TEMPLATES.sendgrid;
    const template = options.template ?? DEFAULT_TEMPLATE_BY_PROVIDER.sendgrid;
    if (!supported.some((item) => item === template)) {
      throw new Error(
        `Unsupported template "${template}" for provider "sendgrid". Supported templates: ${supported.join(", ")}`
      );
    }

    const nowSec = Math.floor(Date.now() / 1000);

    const payloadByTemplate: Record<string, unknown> = {
      delivered: [
        {
          sg_event_id: randomHex(22),
          sg_message_id: `${randomHex(20)}.${randomDigits(4)}`,
          email: "recipient@example.com",
          timestamp: nowSec,
          event: "delivered",
          smtp_id: `<${randomHex(20)}@example.com>`,
          ip: "168.1.1.1",
          response: "250 OK",
          category: ["webhooks-cc-test"],
        },
      ],
      open: [
        {
          sg_event_id: randomHex(22),
          sg_message_id: `${randomHex(20)}.${randomDigits(4)}`,
          email: "recipient@example.com",
          timestamp: nowSec,
          event: "open",
          ip: "72.14.199.28",
          useragent: "Mozilla/5.0",
          category: ["webhooks-cc-test"],
        },
      ],
      bounce: [
        {
          sg_event_id: randomHex(22),
          sg_message_id: `${randomHex(20)}.${randomDigits(4)}`,
          email: "bounced@example.com",
          timestamp: nowSec,
          event: "bounce",
          type: "bounce",
          status: "5.1.1",
          reason: "550 5.1.1 The email account does not exist.",
          ip: "168.1.1.1",
          category: ["webhooks-cc-test"],
        },
      ],
      spam_report: [
        {
          sg_event_id: randomHex(22),
          sg_message_id: `${randomHex(20)}.${randomDigits(4)}`,
          email: "complainant@example.com",
          timestamp: nowSec,
          event: "spamreport",
          category: ["webhooks-cc-test"],
        },
      ],
    };

    const payload = options.body ?? payloadByTemplate[template];
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);

    return {
      method,
      headers: {
        "content-type": "application/json",
        "user-agent": "SendGrid/1.0",
        "x-webhooks-cc-template-provider": "sendgrid",
        "x-webhooks-cc-template-template": template,
        "x-webhooks-cc-template-event": template,
        ...(options.headers ?? {}),
      },
      body,
    };
  }

  // Discord — unsigned provider with template payloads
  if (options.provider === "discord") {
    const method = (options.method ?? "POST").toUpperCase();
    const supported = PROVIDER_TEMPLATES.discord;
    const template = options.template ?? DEFAULT_TEMPLATE_BY_PROVIDER.discord;
    if (!supported.some((item) => item === template)) {
      throw new Error(
        `Unsupported template "${template}" for provider "discord". Supported templates: ${supported.join(", ")}`
      );
    }

    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);

    const payloadByTemplate: Record<string, unknown> = {
      interaction_create: {
        id: randomHex(18),
        application_id: randomHex(18),
        type: 2,
        data: {
          id: randomHex(18),
          name: "webhook-test",
          type: 1,
        },
        guild_id: randomHex(18),
        channel_id: randomHex(18),
        token: randomHex(40),
        version: 1,
      },
      message_component: {
        id: randomHex(18),
        application_id: randomHex(18),
        type: 3,
        data: {
          custom_id: "click_me",
          component_type: 2,
        },
        guild_id: randomHex(18),
        channel_id: randomHex(18),
        token: randomHex(40),
        version: 1,
      },
      ping: {
        id: randomHex(18),
        application_id: randomHex(18),
        type: 1,
        version: 1,
      },
    };

    const payload = options.body ?? payloadByTemplate[template];
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);

    return {
      method,
      headers: {
        "content-type": "application/json",
        "x-signature-timestamp": String(timestamp),
        "x-webhooks-cc-template-provider": "discord",
        "x-webhooks-cc-template-template": template,
        "x-webhooks-cc-template-event": template,
        ...(options.headers ?? {}),
      },
      body,
    };
  }

  // After the early returns, provider is one of the signed template providers
  const provider = options.provider as SignedTemplateProvider;
  const method = (options.method ?? "POST").toUpperCase();
  const template = ensureTemplate(provider, options.template);
  const event = options.event ?? defaultEvent(provider, template);
  const now = new Date();

  const built = buildTemplatePayload(provider, template, event, now, options.body);

  const headers: Record<string, string> = {
    "content-type": built.contentType,
    "x-webhooks-cc-template-provider": provider,
    "x-webhooks-cc-template-template": template,
    "x-webhooks-cc-template-event": event,
    ...built.headers,
  };

  if (provider === "stripe") {
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const signature = await hmacSign("SHA-256", options.secret, `${timestamp}.${built.body}`);
    headers["stripe-signature"] = `t=${timestamp},v1=${toHex(signature)}`;
  }

  if (provider === "github") {
    headers["x-github-event"] = event;
    headers["x-github-delivery"] = randomUuid();
    const signature = await hmacSign("SHA-256", options.secret, built.body);
    headers["x-hub-signature-256"] = `sha256=${toHex(signature)}`;
  }

  if (provider === "shopify") {
    headers["x-shopify-topic"] = event;
    const signature = await hmacSign("SHA-256", options.secret, built.body);
    headers["x-shopify-hmac-sha256"] = toBase64(signature);
  }

  if (provider === "twilio") {
    const signaturePayload = built.twilioParams
      ? buildTwilioSignaturePayload(endpointUrl, built.twilioParams)
      : `${endpointUrl}${built.body}`;
    const signature = await hmacSign("SHA-1", options.secret, signaturePayload);
    headers["x-twilio-signature"] = toBase64(signature);
  }

  if (provider === "slack") {
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const signature = await hmacSign("SHA-256", options.secret, `v0:${timestamp}:${built.body}`);
    headers["x-slack-request-timestamp"] = String(timestamp);
    headers["x-slack-signature"] = `v0=${toHex(signature)}`;
  }

  if (provider === "paddle") {
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const signature = await hmacSign("SHA-256", options.secret, `${timestamp}:${built.body}`);
    headers["paddle-signature"] = `ts=${timestamp};h1=${toHex(signature)}`;
  }

  if (provider === "linear") {
    const signature = await hmacSign("SHA-256", options.secret, built.body);
    headers["linear-signature"] = `sha256=${toHex(signature)}`;
  }

  if (provider === "clerk") {
    const msgId = `msg_${randomHex(16)}`;
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const signingInput = `${msgId}.${timestamp}.${built.body}`;
    const secretBytes = decodeStandardWebhookSecret(options.secret);
    const signature = await hmacSignRaw("SHA-256", secretBytes, signingInput);
    const sig = `v1,${toBase64(signature)}`;
    headers["webhook-id"] = msgId;
    headers["webhook-timestamp"] = String(timestamp);
    headers["webhook-signature"] = sig;
    headers["svix-id"] = msgId;
    headers["svix-timestamp"] = String(timestamp);
    headers["svix-signature"] = sig;
  }

  if (provider === "vercel") {
    const signature = await hmacSign("SHA-1", options.secret, built.body);
    headers["x-vercel-signature"] = toHex(signature);
  }

  if (provider === "gitlab") {
    headers["x-gitlab-token"] = options.secret;
    const gitlabEvent = template === "merge_request" ? "Merge Request Hook" : "Push Hook";
    headers["x-gitlab-event"] = gitlabEvent;
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
