/**
 * Dashboard webhook template system.
 *
 * UI-specific template metadata (labels, descriptions) lives here.
 * Signing logic, payload generation, and provider constants are imported
 * from @webhooks-cc/sdk — the single source of truth.
 */

import {
  TEMPLATE_METADATA,
  buildTemplateSendOptions,
  type TemplateProvider,
  type SendTemplateOptions,
} from "@webhooks-cc/sdk";

export type { TemplateProvider } from "@webhooks-cc/sdk";

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

const TEMPLATE_PRESETS: Partial<Record<TemplateProvider, readonly TemplatePreset[]>> = {
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
  "standard-webhooks": [
    {
      id: "custom",
      label: "Custom payload",
      description:
        "Standard Webhooks signed payload with webhook-id/webhook-timestamp/webhook-signature headers",
      event: "custom",
      contentType: "application/json",
    },
  ],
};

export function getTemplatePresets(provider: TemplateProvider): readonly TemplatePreset[] {
  return TEMPLATE_PRESETS[provider] ?? [];
}

export function getDefaultTemplateId(provider: TemplateProvider): string {
  const presets = TEMPLATE_PRESETS[provider];
  if (presets && presets.length > 0) return presets[0].id;
  return "custom";
}

export function isSecretRequired(provider: TemplateProvider): boolean {
  return TEMPLATE_METADATA[provider].secretRequired;
}

export async function buildTemplateRequest({
  provider,
  template,
  secret,
  event,
  targetUrl,
  bodyOverride,
}: BuildTemplateInput): Promise<TemplateRequest> {
  const sdkOptions: SendTemplateOptions = {
    provider,
    template,
    secret,
    event: event?.trim() || undefined,
    body: bodyOverride,
  };

  let result;
  try {
    result = await buildTemplateSendOptions(targetUrl, sdkOptions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to build ${provider} template request: ${message}`);
  }

  let body: string;
  if (typeof result.body === "string") {
    body = result.body;
  } else if (result.body != null) {
    try {
      body = JSON.stringify(result.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to serialize ${provider} template body: ${message}`);
    }
  } else {
    body = "";
  }

  return { method: "POST", headers: result.headers ?? {}, body };
}
