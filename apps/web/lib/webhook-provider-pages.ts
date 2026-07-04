import { TEMPLATE_METADATA, TEMPLATE_PROVIDERS, type TemplateProvider } from "@webhooks-cc/sdk";
import { getWebProviderCredentialLabel, getWebProviderInfo } from "./provider-catalog";

export type WebhookProviderCategory =
  "Payments & billing" | "Dev & deploy" | "Communication" | "Commerce & SaaS" | "Identity & data";

interface ProviderEditorial {
  /** What this provider's webhooks notify you about — one factual sentence. */
  blurb: string;
  /** Where webhooks are configured for this provider. */
  configHint: string;
  category: WebhookProviderCategory;
}

const PROVIDER_EDITORIAL: Record<TemplateProvider, ProviderEditorial> = {
  stripe: {
    blurb:
      "Stripe sends webhooks for payments, checkout sessions, invoices, subscriptions, and disputes — they are the backbone of most billing integrations.",
    configHint: "Stripe Dashboard → Developers → Webhooks → Add endpoint",
    category: "Payments & billing",
  },
  github: {
    blurb:
      "GitHub sends webhooks for pushes, pull requests, releases, issues, and workflow runs on repositories and organizations.",
    configHint: "Repository → Settings → Webhooks → Add webhook",
    category: "Dev & deploy",
  },
  shopify: {
    blurb:
      "Shopify sends webhooks for orders, products, inventory, customers, and app lifecycle events in your store.",
    configHint: "Shopify Admin → Settings → Notifications → Webhooks (or via the Admin API)",
    category: "Commerce & SaaS",
  },
  twilio: {
    blurb:
      "Twilio sends webhooks for inbound SMS, message status callbacks, and incoming voice calls.",
    configHint: "Twilio Console → Phone Numbers → your number → Messaging/Voice webhook URL",
    category: "Communication",
  },
  slack: {
    blurb:
      "Slack sends webhooks for workspace events, slash commands, and interactive components via the Events API.",
    configHint: "Slack API dashboard → your app → Event Subscriptions → Request URL",
    category: "Communication",
  },
  paddle: {
    blurb:
      "Paddle sends webhooks for transactions, subscriptions, customers, and adjustments in Paddle Billing.",
    configHint: "Paddle Dashboard → Developer Tools → Notifications → New destination",
    category: "Payments & billing",
  },
  linear: {
    blurb: "Linear sends webhooks for issue, comment, project, and cycle changes in a workspace.",
    configHint: "Linear → Settings → API → Webhooks → New webhook",
    category: "Commerce & SaaS",
  },
  sendgrid: {
    blurb:
      "SendGrid sends event webhooks for email delivery, opens, clicks, bounces, and spam reports.",
    configHint: "SendGrid → Settings → Mail Settings → Event Webhook",
    category: "Communication",
  },
  clerk: {
    blurb:
      "Clerk sends webhooks for user, session, and organization lifecycle events, signed with Svix-style headers.",
    configHint: "Clerk Dashboard → Webhooks → Add endpoint",
    category: "Identity & data",
  },
  discord: {
    blurb:
      "Discord sends interaction webhooks for slash commands and message components to your interactions endpoint URL.",
    configHint:
      "Discord Developer Portal → your app → General Information → Interactions Endpoint URL",
    category: "Communication",
  },
  vercel: {
    blurb:
      "Vercel sends webhooks for deployment lifecycle events — created, succeeded, failed — across your projects.",
    configHint: "Vercel Dashboard → Team Settings → Webhooks",
    category: "Dev & deploy",
  },
  gitlab: {
    blurb:
      "GitLab sends webhooks for pushes, merge requests, pipelines, issues, and tag events on projects and groups.",
    configHint: "Project → Settings → Webhooks",
    category: "Dev & deploy",
  },
  typeform: {
    blurb: "Typeform sends webhooks each time someone submits (or partially completes) a form.",
    configHint: "Typeform → your form → Connect → Webhooks",
    category: "Commerce & SaaS",
  },
  "standard-webhooks": {
    blurb:
      "Standard Webhooks is an open specification for webhook signing and delivery adopted by providers like Svix, Clerk, and Resend.",
    configHint: "Any provider implementing the Standard Webhooks spec",
    category: "Identity & data",
  },
  meta: {
    blurb:
      "Meta sends webhooks for WhatsApp messages, Facebook Page events, and Instagram comments through the Graph API.",
    configHint: "Meta for Developers → your app → Webhooks → Edit subscription",
    category: "Communication",
  },
  lemonsqueezy: {
    blurb:
      "Lemon Squeezy sends webhooks for orders, subscriptions, and license key events in your store.",
    configHint: "Lemon Squeezy → Settings → Webhooks",
    category: "Payments & billing",
  },
  "coinbase-commerce": {
    blurb:
      "Coinbase Commerce sends webhooks as crypto charges are created, pending, confirmed, or failed.",
    configHint: "Coinbase Commerce → Settings → Webhook subscriptions",
    category: "Payments & billing",
  },
  razorpay: {
    blurb:
      "Razorpay sends webhooks for payments, orders, settlements, refunds, and subscription events.",
    configHint: "Razorpay Dashboard → Account & Settings → Webhooks",
    category: "Payments & billing",
  },
  cal: {
    blurb:
      "Cal.com sends webhooks when bookings are created, cancelled, rescheduled, or completed.",
    configHint: "Cal.com → Settings → Developer → Webhooks",
    category: "Commerce & SaaS",
  },
  intercom: {
    blurb:
      "Intercom sends webhooks for conversations, contacts, and admin replies in your workspace.",
    configHint: "Intercom Developer Hub → your app → Webhooks",
    category: "Communication",
  },
  telegram: {
    blurb:
      "Telegram bots receive updates — messages, callback queries, edits — via a webhook URL registered with setWebhook.",
    configHint: "Bot API → call setWebhook with your endpoint URL",
    category: "Communication",
  },
  square: {
    blurb: "Square sends webhooks for payments, refunds, orders, inventory, and catalog changes.",
    configHint: "Square Developer Dashboard → your app → Webhooks → Subscriptions",
    category: "Payments & billing",
  },
  hubspot: {
    blurb:
      "HubSpot sends webhooks for CRM object changes — contact creation, property changes, deal updates.",
    configHint: "HubSpot developer account → your app → Webhooks",
    category: "Commerce & SaaS",
  },
  mailgun: {
    blurb: "Mailgun sends webhooks for email delivery, failures, opens, clicks, and unsubscribes.",
    configHint: "Mailgun → Sending → Webhooks",
    category: "Communication",
  },
  calendly: {
    blurb: "Calendly sends webhooks when invitees schedule, cancel, or submit routing forms.",
    configHint: "Calendly API → create a webhook subscription (or Integrations page on paid plans)",
    category: "Commerce & SaaS",
  },
  mux: {
    blurb:
      "Mux sends webhooks for video asset lifecycle events — uploads, processing, ready states, and live streams.",
    configHint: "Mux Dashboard → Settings → Webhooks",
    category: "Dev & deploy",
  },
  sentry: {
    blurb:
      "Sentry sends webhooks for issues, errors, and alert rule triggers via internal integrations.",
    configHint: "Sentry → Settings → Developer Settings → your integration → Webhook URL",
    category: "Dev & deploy",
  },
  bitbucket: {
    blurb:
      "Bitbucket sends webhooks for pushes, pull requests, and pipeline events on repositories.",
    configHint: "Repository → Settings → Webhooks → Add webhook",
    category: "Dev & deploy",
  },
  docusign: {
    blurb:
      "DocuSign Connect sends webhooks as envelopes are sent, viewed, signed, completed, or declined.",
    configHint: "DocuSign Admin → Integrations → Connect → Add Configuration",
    category: "Identity & data",
  },
  adyen: {
    blurb:
      "Adyen sends standard notification webhooks for authorisations, captures, refunds, and chargebacks.",
    configHint: "Adyen Customer Area → Developers → Webhooks → Create webhook",
    category: "Payments & billing",
  },
  paypal: {
    blurb:
      "PayPal sends webhooks for captures, checkout orders, subscriptions, and disputes in your REST app.",
    configHint: "PayPal Developer Dashboard → your app → Webhooks → Add webhook",
    category: "Payments & billing",
  },
  plaid: {
    blurb:
      "Plaid sends webhooks for transactions updates, item status changes, and auth events, verified with signed JWTs.",
    configHint: "Set the webhook URL when creating a Link token (or via /item/webhook/update)",
    category: "Identity & data",
  },
};

// Keyed by both the raw SDK algorithm ids and the catalog's formatted strings,
// so the catalog-first resolution below still yields the most descriptive copy.
const ALGORITHM_LABELS: Record<string, string> = {
  "hmac-sha256": "HMAC-SHA256",
  "hmac-sha1": "HMAC-SHA1",
  "rsa-sha256": "RSA-SHA256 (certificate-based)",
  "RSA-SHA256": "RSA-SHA256 (certificate-based)",
  "jwt-es256": "JWT (ES256)",
  "JWT ES256": "JWT (ES256)",
  token: "Shared token comparison",
  Token: "Shared token comparison",
};

export interface WebhookProviderPage {
  slug: TemplateProvider;
  label: string;
  blurb: string;
  configHint: string;
  category: WebhookProviderCategory;
  /** Sample event templates webhooks.cc can send for this provider. */
  templates: readonly string[];
  defaultTemplate: string | null;
  signatureHeader: string | null;
  signatureAlgorithm: string | null;
  signatureAlgorithmLabel: string | null;
  secretRequired: boolean;
  /** Whether the dashboard/SDK can verify inbound signatures for this provider. */
  verifySupported: boolean;
  /** Human label for the credential users add to verify (e.g. "Signing Secret", "Public Key"). */
  credentialLabel: string;
}

export const WEBHOOK_PROVIDER_SLUGS: readonly TemplateProvider[] = TEMPLATE_PROVIDERS;

// All page data derives from static SDK metadata, so build it once at module
// load and serve lookups from a Map.
let pagesBySlug: ReadonlyMap<string, WebhookProviderPage> | null = null;

function getPagesBySlug(): ReadonlyMap<string, WebhookProviderPage> {
  if (!pagesBySlug) {
    pagesBySlug = new Map(
      WEBHOOK_PROVIDER_SLUGS.map((slug) => [slug as string, buildWebhookProviderPage(slug)])
    );
  }
  return pagesBySlug;
}

export function getWebhookProviderPage(slug: string): WebhookProviderPage | null {
  return getPagesBySlug().get(slug) ?? null;
}

function buildWebhookProviderPage(provider: TemplateProvider): WebhookProviderPage {
  const meta = TEMPLATE_METADATA[provider];
  const editorial = PROVIDER_EDITORIAL[provider];
  const info = getWebProviderInfo(provider);
  const sdkAlgorithm = "signatureAlgorithm" in meta ? meta.signatureAlgorithm : null;
  const sdkHeader = "signatureHeader" in meta ? (meta.signatureHeader ?? null) : null;

  // The web provider catalog carries hand-tuned overrides the raw SDK template
  // metadata lacks — e.g. Discord verifies with the x-signature-ed25519 header
  // using Ed25519, neither of which is in its SDK template. Prefer the catalog
  // so this page never contradicts the catalog the dashboard verifies against.
  const catalogHeader = info?.header ? info.header : null;
  const catalogAlgorithm =
    info?.algorithm && info.algorithm !== "Not applicable" ? info.algorithm : null;
  const signatureHeader = catalogHeader ?? sdkHeader;
  // Catalog overrides win (consistent with signatureHeader above), falling back
  // to the SDK's raw algorithm id; either form is enriched via ALGORITHM_LABELS.
  const resolvedAlgorithm = catalogAlgorithm ?? sdkAlgorithm ?? null;
  const signatureAlgorithmLabel = resolvedAlgorithm
    ? (ALGORITHM_LABELS[resolvedAlgorithm] ?? resolvedAlgorithm)
    : null;

  return {
    slug: provider,
    label: info?.label ?? provider,
    blurb: editorial.blurb,
    configHint: editorial.configHint,
    category: editorial.category,
    templates: meta.templates,
    defaultTemplate: "defaultTemplate" in meta ? meta.defaultTemplate : null,
    signatureHeader,
    signatureAlgorithm: resolvedAlgorithm,
    signatureAlgorithmLabel,
    secretRequired: meta.secretRequired,
    verifySupported: info?.verificationMode === "secret" || info?.verificationMode === "publicKey",
    credentialLabel: getWebProviderCredentialLabel(provider),
  };
}

export function getAllWebhookProviderPages(): readonly WebhookProviderPage[] {
  return [...getPagesBySlug().values()];
}

export const WEBHOOK_PROVIDER_CATEGORIES: readonly WebhookProviderCategory[] = [
  "Payments & billing",
  "Dev & deploy",
  "Communication",
  "Commerce & SaaS",
  "Identity & data",
];
