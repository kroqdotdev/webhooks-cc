/**
 * Dashboard webhook template system.
 *
 * This file is INDEPENDENT from @webhooks-cc/sdk but the TemplateProvider
 * union and template preset IDs must stay in sync with the SDK's
 * `packages/sdk/src/templates.ts`. When adding a new provider in the SDK,
 * add the corresponding presets, payloads, and signing logic here too.
 */

export type TemplateProvider =
  | "stripe"
  | "github"
  | "shopify"
  | "twilio"
  | "slack"
  | "paddle"
  | "linear"
  | "sendgrid"
  | "clerk"
  | "discord"
  | "vercel"
  | "gitlab";

type TwilioParamEntry = [string, string];

export interface TemplatePreset {
  id: string;
  label: string;
  description: string;
  event: string;
  contentType: "application/json" | "application/x-www-form-urlencoded";
}

export interface BuildTemplateInput {
  provider: TemplateProvider;
  template?: string;
  secret: string;
  event?: string;
  targetUrl: string;
  bodyOverride?: unknown;
}

export interface TemplateRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/** Whether a provider requires a signing secret in the UI. */
export const PROVIDER_SECRET_REQUIRED: Record<TemplateProvider, boolean> = {
  stripe: true,
  github: true,
  shopify: true,
  twilio: true,
  slack: true,
  paddle: true,
  linear: true,
  sendgrid: false,
  clerk: true,
  discord: false,
  vercel: true,
  gitlab: true,
};

const TEMPLATE_PRESETS: Record<TemplateProvider, readonly TemplatePreset[]> = {
  stripe: [
    {
      id: "payment_intent.succeeded",
      label: "Payment intent succeeded",
      description: "Stripe payment_intent.succeeded event payload",
      event: "payment_intent.succeeded",
      contentType: "application/json",
    },
    {
      id: "checkout.session.completed",
      label: "Checkout session completed",
      description: "Stripe checkout.session.completed event payload",
      event: "checkout.session.completed",
      contentType: "application/json",
    },
    {
      id: "invoice.paid",
      label: "Invoice paid",
      description: "Stripe invoice.paid event payload",
      event: "invoice.paid",
      contentType: "application/json",
    },
  ],
  github: [
    {
      id: "push",
      label: "Push",
      description: "GitHub push webhook payload",
      event: "push",
      contentType: "application/json",
    },
    {
      id: "pull_request.opened",
      label: "Pull request opened",
      description: "GitHub pull_request event with action=opened",
      event: "pull_request",
      contentType: "application/json",
    },
    {
      id: "ping",
      label: "Ping",
      description: "GitHub ping webhook payload",
      event: "ping",
      contentType: "application/json",
    },
  ],
  shopify: [
    {
      id: "orders/create",
      label: "Order created",
      description: "Shopify orders/create webhook payload",
      event: "orders/create",
      contentType: "application/json",
    },
    {
      id: "orders/paid",
      label: "Order paid",
      description: "Shopify orders/paid webhook payload",
      event: "orders/paid",
      contentType: "application/json",
    },
    {
      id: "products/update",
      label: "Product updated",
      description: "Shopify products/update webhook payload",
      event: "products/update",
      contentType: "application/json",
    },
    {
      id: "app/uninstalled",
      label: "App uninstalled",
      description: "Shopify app/uninstalled webhook payload",
      event: "app/uninstalled",
      contentType: "application/json",
    },
  ],
  twilio: [
    {
      id: "messaging.inbound",
      label: "Messaging inbound",
      description: "Twilio inbound SMS webhook params",
      event: "messaging.inbound",
      contentType: "application/x-www-form-urlencoded",
    },
    {
      id: "messaging.status_callback",
      label: "Message status callback",
      description: "Twilio message delivery callback params",
      event: "messaging.status_callback",
      contentType: "application/x-www-form-urlencoded",
    },
    {
      id: "voice.incoming_call",
      label: "Voice incoming call",
      description: "Twilio incoming voice call webhook params",
      event: "voice.incoming_call",
      contentType: "application/x-www-form-urlencoded",
    },
  ],
  slack: [
    {
      id: "event_callback",
      label: "Event callback",
      description: "Slack Events API event_callback payload",
      event: "event_callback",
      contentType: "application/json",
    },
    {
      id: "slash_command",
      label: "Slash command",
      description: "Slack slash command form-encoded payload",
      event: "slash_command",
      contentType: "application/x-www-form-urlencoded",
    },
    {
      id: "url_verification",
      label: "URL verification",
      description: "Slack URL verification challenge payload",
      event: "url_verification",
      contentType: "application/json",
    },
  ],
  paddle: [
    {
      id: "transaction.completed",
      label: "Transaction completed",
      description: "Paddle transaction.completed notification payload",
      event: "transaction.completed",
      contentType: "application/json",
    },
    {
      id: "subscription.created",
      label: "Subscription created",
      description: "Paddle subscription.created notification payload",
      event: "subscription.created",
      contentType: "application/json",
    },
    {
      id: "subscription.updated",
      label: "Subscription updated",
      description: "Paddle subscription.updated notification payload",
      event: "subscription.updated",
      contentType: "application/json",
    },
  ],
  linear: [
    {
      id: "issue.create",
      label: "Issue created",
      description: "Linear issue.create webhook payload",
      event: "issue.create",
      contentType: "application/json",
    },
    {
      id: "issue.update",
      label: "Issue updated",
      description: "Linear issue.update webhook payload",
      event: "issue.update",
      contentType: "application/json",
    },
    {
      id: "comment.create",
      label: "Comment created",
      description: "Linear comment.create webhook payload",
      event: "comment.create",
      contentType: "application/json",
    },
  ],
  sendgrid: [
    {
      id: "delivered",
      label: "Delivered",
      description: "SendGrid delivered event webhook payload",
      event: "delivered",
      contentType: "application/json",
    },
    {
      id: "open",
      label: "Open",
      description: "SendGrid open event webhook payload",
      event: "open",
      contentType: "application/json",
    },
    {
      id: "bounce",
      label: "Bounce",
      description: "SendGrid bounce event webhook payload",
      event: "bounce",
      contentType: "application/json",
    },
    {
      id: "spam_report",
      label: "Spam report",
      description: "SendGrid spam report event webhook payload",
      event: "spam_report",
      contentType: "application/json",
    },
  ],
  clerk: [
    {
      id: "user.created",
      label: "User created",
      description: "Clerk user.created webhook payload",
      event: "user.created",
      contentType: "application/json",
    },
    {
      id: "user.updated",
      label: "User updated",
      description: "Clerk user.updated webhook payload",
      event: "user.updated",
      contentType: "application/json",
    },
    {
      id: "user.deleted",
      label: "User deleted",
      description: "Clerk user.deleted webhook payload",
      event: "user.deleted",
      contentType: "application/json",
    },
    {
      id: "session.created",
      label: "Session created",
      description: "Clerk session.created webhook payload",
      event: "session.created",
      contentType: "application/json",
    },
  ],
  discord: [
    {
      id: "interaction_create",
      label: "Interaction create",
      description: "Discord Interaction create payload",
      event: "interaction_create",
      contentType: "application/json",
    },
    {
      id: "message_component",
      label: "Message component",
      description: "Discord message component interaction payload",
      event: "message_component",
      contentType: "application/json",
    },
    {
      id: "ping",
      label: "Ping",
      description: "Discord ping interaction payload",
      event: "ping",
      contentType: "application/json",
    },
  ],
  vercel: [
    {
      id: "deployment.created",
      label: "Deployment created",
      description: "Vercel deployment.created webhook payload",
      event: "deployment.created",
      contentType: "application/json",
    },
    {
      id: "deployment.succeeded",
      label: "Deployment succeeded",
      description: "Vercel deployment.succeeded webhook payload",
      event: "deployment.succeeded",
      contentType: "application/json",
    },
    {
      id: "deployment.error",
      label: "Deployment error",
      description: "Vercel deployment.error webhook payload",
      event: "deployment.error",
      contentType: "application/json",
    },
  ],
  gitlab: [
    {
      id: "push",
      label: "Push",
      description: "GitLab push webhook payload",
      event: "push",
      contentType: "application/json",
    },
    {
      id: "merge_request",
      label: "Merge request",
      description: "GitLab merge request webhook payload",
      event: "merge_request",
      contentType: "application/json",
    },
  ],
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

function randomSnowflake(): string {
  return randomDigits(18);
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

function findPreset(provider: TemplateProvider, template?: string): TemplatePreset {
  const presets = TEMPLATE_PRESETS[provider];
  if (!template) return presets[0];
  const selected = presets.find((preset) => preset.id === template);
  if (selected) return selected;
  throw new Error(
    `Unsupported template "${template}" for provider "${provider}". Supported templates: ${presets
      .map((preset) => preset.id)
      .join(", ")}`
  );
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

function buildPayload(
  provider: TemplateProvider,
  preset: TemplatePreset,
  event: string,
  now: Date,
  bodyOverride?: unknown
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

    const payload = bodyOverride ?? payloadByTemplate[preset.id];
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

    const payload = bodyOverride ?? payloadByTemplate[preset.id];
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

    const payload = bodyOverride ?? payloadByTemplate[preset.id];
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

    if (preset.id === "slash_command") {
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
      (preset.id === "url_verification" ? verificationPayload : eventCallbackPayload);
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

    const payload = bodyOverride ?? payloadByTemplate[preset.id];
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

    const payload = bodyOverride ?? payloadByTemplate[preset.id];
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    return {
      body,
      contentType: "application/json",
      headers: {
        "user-agent": "Linear/1.0",
      },
    };
  }

  if (provider === "sendgrid") {
    const sgTimestamp = nowSec;
    const sgMessageId = `${randomHex(22)}.${randomHex(8)}`;
    const payloadByTemplate: Record<string, unknown> = {
      delivered: [
        {
          email: "customer@example.com",
          timestamp: sgTimestamp,
          event: "delivered",
          sg_event_id: randomHex(22),
          sg_message_id: sgMessageId,
          response: "250 OK",
          smtp_id: `<${randomHex(16)}@example.com>`,
          category: ["webhooks-cc-demo"],
        },
      ],
      open: [
        {
          email: "customer@example.com",
          timestamp: sgTimestamp,
          event: "open",
          sg_event_id: randomHex(22),
          sg_message_id: sgMessageId,
          useragent: "Mozilla/5.0",
          ip: "203.0.113.42",
          category: ["webhooks-cc-demo"],
        },
      ],
      bounce: [
        {
          email: "invalid@example.com",
          timestamp: sgTimestamp,
          event: "bounce",
          sg_event_id: randomHex(22),
          sg_message_id: sgMessageId,
          reason: "550 5.1.1 The email account does not exist",
          type: "bounce",
          status: "5.1.1",
          category: ["webhooks-cc-demo"],
        },
      ],
      spam_report: [
        {
          email: "customer@example.com",
          timestamp: sgTimestamp,
          event: "spamreport",
          sg_event_id: randomHex(22),
          sg_message_id: sgMessageId,
          category: ["webhooks-cc-demo"],
        },
      ],
    };

    const payload = bodyOverride ?? payloadByTemplate[preset.id];
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    return {
      body,
      contentType: "application/json",
      headers: {
        "user-agent": "SendGrid Event Webhook",
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
          first_name: "Webhook",
          last_name: "Tester",
          email_addresses: [
            {
              id: `idn_${randomHex(24)}`,
              email_address: "tester@webhooks.cc",
              verification: { status: "verified", strategy: "email_code" },
            },
          ],
          primary_email_address_id: `idn_${randomHex(24)}`,
          created_at: nowSec * 1000,
          updated_at: nowSec * 1000,
        },
        object: "event",
        type: event,
        timestamp: nowSec * 1000,
      },
      "user.updated": {
        data: {
          id: userId,
          object: "user",
          first_name: "Webhook",
          last_name: "Tester (Updated)",
          email_addresses: [
            {
              id: `idn_${randomHex(24)}`,
              email_address: "tester@webhooks.cc",
              verification: { status: "verified", strategy: "email_code" },
            },
          ],
          primary_email_address_id: `idn_${randomHex(24)}`,
          created_at: nowSec * 1000,
          updated_at: nowSec * 1000,
        },
        object: "event",
        type: event,
        timestamp: nowSec * 1000,
      },
      "user.deleted": {
        data: {
          id: userId,
          object: "user",
          deleted: true,
        },
        object: "event",
        type: event,
        timestamp: nowSec * 1000,
      },
      "session.created": {
        data: {
          id: `sess_${randomHex(24)}`,
          object: "session",
          user_id: userId,
          status: "active",
          expire_at: (nowSec + 86400) * 1000,
          created_at: nowSec * 1000,
          updated_at: nowSec * 1000,
        },
        object: "event",
        type: event,
        timestamp: nowSec * 1000,
      },
    };

    const payload = bodyOverride ?? payloadByTemplate[preset.id];
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    return {
      body,
      contentType: "application/json",
      headers: {},
    };
  }

  if (provider === "discord") {
    const applicationId = randomSnowflake();
    const payloadByTemplate: Record<string, unknown> = {
      interaction_create: {
        id: randomSnowflake(),
        application_id: applicationId,
        type: 2,
        data: {
          id: randomSnowflake(),
          name: "webhook-test",
          type: 1,
        },
        guild_id: randomSnowflake(),
        channel_id: randomSnowflake(),
        member: {
          user: {
            id: randomSnowflake(),
            username: "webhooks-cc-bot",
            discriminator: "0",
            global_name: "Webhooks.cc Bot",
          },
        },
        token: randomHex(64),
        version: 1,
      },
      message_component: {
        id: randomSnowflake(),
        application_id: applicationId,
        type: 3,
        data: {
          custom_id: "webhook_test_button",
          component_type: 2,
        },
        guild_id: randomSnowflake(),
        channel_id: randomSnowflake(),
        member: {
          user: {
            id: randomSnowflake(),
            username: "webhooks-cc-bot",
            discriminator: "0",
            global_name: "Webhooks.cc Bot",
          },
        },
        token: randomHex(64),
        version: 1,
      },
      ping: {
        id: randomSnowflake(),
        application_id: applicationId,
        type: 1,
        token: randomHex(64),
        version: 1,
      },
    };

    const payload = bodyOverride ?? payloadByTemplate[preset.id];
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    return {
      body,
      contentType: "application/json",
      headers: {},
    };
  }

  if (provider === "vercel") {
    const deploymentId = `dpl_${randomHex(20)}`;
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
          project: {
            id: `prj_${randomHex(20)}`,
            name: "webhooks-cc-web",
          },
          team: {
            id: `team_${randomHex(20)}`,
            name: "webhooks-cc",
          },
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
          project: {
            id: `prj_${randomHex(20)}`,
            name: "webhooks-cc-web",
          },
          team: {
            id: `team_${randomHex(20)}`,
            name: "webhooks-cc",
          },
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
          project: {
            id: `prj_${randomHex(20)}`,
            name: "webhooks-cc-web",
          },
          team: {
            id: `team_${randomHex(20)}`,
            name: "webhooks-cc",
          },
        },
      },
    };

    const payload = bodyOverride ?? payloadByTemplate[preset.id];
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    return {
      body,
      contentType: "application/json",
      headers: {},
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
        user_id: Number(randomDigits(7)),
        user_name: "webhooks-cc-bot",
        user_username: "webhooks-cc-bot",
        user_email: "bot@webhooks.cc",
        project_id: projectId,
        project: {
          id: projectId,
          name: "demo-repo",
          description: "Demo repository for webhooks.cc",
          web_url: "https://gitlab.com/webhooks-cc/demo-repo",
          namespace: "webhooks-cc",
          default_branch: "main",
        },
        commits: [
          {
            id: randomHex(40),
            message: "Update webhook integration tests",
            timestamp: nowIso,
            url: `https://gitlab.com/webhooks-cc/demo-repo/-/commit/${randomHex(40)}`,
            author: {
              name: "webhooks-cc-bot",
              email: "bot@webhooks.cc",
            },
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
          id: Number(randomDigits(7)),
          name: "webhooks-cc-bot",
          username: "webhooks-cc-bot",
          email: "bot@webhooks.cc",
        },
        project: {
          id: projectId,
          name: "demo-repo",
          description: "Demo repository for webhooks.cc",
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

    const payload = bodyOverride ?? payloadByTemplate[preset.id];
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    return {
      body,
      contentType: "application/json",
      headers: {},
    };
  }

  // Twilio is the last remaining provider (form-encoded)
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
    twilioParams = defaultTwilioParamsByTemplate[preset.id];
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

async function hmacSignRaw(
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

function fromBase64(str: string): Uint8Array {
  if (typeof atob !== "function") {
    return new Uint8Array(Buffer.from(str, "base64"));
  }
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeStandardWebhookSecret(secret: string): Uint8Array {
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

export function getTemplatePresets(provider: TemplateProvider): readonly TemplatePreset[] {
  return TEMPLATE_PRESETS[provider];
}

export function getDefaultTemplateId(provider: TemplateProvider): string {
  return TEMPLATE_PRESETS[provider][0].id;
}

export function isSecretRequired(provider: TemplateProvider): boolean {
  return PROVIDER_SECRET_REQUIRED[provider];
}

export async function buildTemplateRequest({
  provider,
  template,
  secret,
  event,
  targetUrl,
  bodyOverride,
}: BuildTemplateInput): Promise<TemplateRequest> {
  const preset = findPreset(provider, template);
  const resolvedEvent = event?.trim() || preset.event;
  const now = new Date();

  const built = buildPayload(provider, preset, resolvedEvent, now, bodyOverride);

  const headers: Record<string, string> = {
    "content-type": built.contentType,
    "x-webhooks-cc-template-provider": provider,
    "x-webhooks-cc-template-template": preset.id,
    "x-webhooks-cc-template-event": resolvedEvent,
    ...built.headers,
  };

  if (provider === "stripe") {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await hmacSign("SHA-256", secret, `${timestamp}.${built.body}`);
    headers["stripe-signature"] = `t=${timestamp},v1=${toHex(signature)}`;
  }

  if (provider === "github") {
    headers["x-github-event"] = resolvedEvent;
    headers["x-github-delivery"] = randomUuid();
    const signature = await hmacSign("SHA-256", secret, built.body);
    headers["x-hub-signature-256"] = `sha256=${toHex(signature)}`;
  }

  if (provider === "shopify") {
    headers["x-shopify-topic"] = resolvedEvent;
    const signature = await hmacSign("SHA-256", secret, built.body);
    headers["x-shopify-hmac-sha256"] = toBase64(signature);
  }

  if (provider === "twilio") {
    const signaturePayload = built.twilioParams
      ? buildTwilioSignaturePayload(targetUrl, built.twilioParams)
      : `${targetUrl}${built.body}`;
    const signature = await hmacSign("SHA-1", secret, signaturePayload);
    headers["x-twilio-signature"] = toBase64(signature);
  }

  if (provider === "slack") {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await hmacSign("SHA-256", secret, `v0:${timestamp}:${built.body}`);
    headers["x-slack-request-timestamp"] = String(timestamp);
    headers["x-slack-signature"] = `v0=${toHex(signature)}`;
  }

  if (provider === "paddle") {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await hmacSign("SHA-256", secret, `${timestamp}:${built.body}`);
    headers["paddle-signature"] = `ts=${timestamp};h1=${toHex(signature)}`;
  }

  if (provider === "linear") {
    const signature = await hmacSign("SHA-256", secret, built.body);
    headers["linear-signature"] = `sha256=${toHex(signature)}`;
  }

  // sendgrid: no signing required

  if (provider === "clerk") {
    // Clerk uses Standard Webhooks signing (Svix)
    const msgId = `msg_${randomHex(16)}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const signingInput = `${msgId}.${timestamp}.${built.body}`;
    const secretBytes = decodeStandardWebhookSecret(secret);
    const signature = await hmacSignRaw("SHA-256", secretBytes, signingInput);
    const sig = `v1,${toBase64(signature)}`;
    headers["webhook-id"] = msgId;
    headers["webhook-timestamp"] = String(timestamp);
    headers["webhook-signature"] = sig;
    // Svix compatibility duplicates
    headers["svix-id"] = msgId;
    headers["svix-timestamp"] = String(timestamp);
    headers["svix-signature"] = sig;
  }

  // discord: no signing required (uses Ed25519 public key verification, not HMAC)

  if (provider === "vercel") {
    const signature = await hmacSign("SHA-1", secret, built.body);
    headers["x-vercel-signature"] = toHex(signature);
  }

  if (provider === "gitlab") {
    headers["x-gitlab-token"] = secret;
    const eventHookName = preset.id === "merge_request" ? "Merge Request Hook" : "Push Hook";
    headers["x-gitlab-event"] = eventHookName;
  }

  return { method: "POST", headers, body: built.body };
}
