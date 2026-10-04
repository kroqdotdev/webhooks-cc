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
  /** Day this page's content last changed (YYYY-MM-DD). Drives its sitemap lastmod. */
  updated: string;
}

const PROVIDER_EDITORIAL: Record<TemplateProvider, ProviderEditorial> = {
  stripe: {
    blurb:
      "Stripe sends webhooks for payments, checkout sessions, invoices, subscriptions, and disputes — they are the backbone of most billing integrations.",
    configHint: "Stripe Dashboard → Developers → Webhooks → Add endpoint",
    category: "Payments & billing",
    updated: "2026-08-21",
  },
  github: {
    blurb:
      "GitHub sends webhooks for pushes, pull requests, releases, issues, and workflow runs on repositories and organizations.",
    configHint: "Repository → Settings → Webhooks → Add webhook",
    category: "Dev & deploy",
    updated: "2026-08-21",
  },
  shopify: {
    blurb:
      "Shopify sends webhooks for orders, products, inventory, customers, and app lifecycle events in your store.",
    configHint: "Shopify Admin → Settings → Notifications → Webhooks (or via the Admin API)",
    category: "Commerce & SaaS",
    updated: "2026-08-21",
  },
  twilio: {
    blurb:
      "Twilio sends webhooks for inbound SMS, message status callbacks, and incoming voice calls.",
    configHint: "Twilio Console → Phone Numbers → your number → Messaging/Voice webhook URL",
    category: "Communication",
    updated: "2026-08-21",
  },
  slack: {
    blurb:
      "Slack sends webhooks for workspace events, slash commands, and interactive components via the Events API.",
    configHint: "Slack API dashboard → your app → Event Subscriptions → Request URL",
    category: "Communication",
    updated: "2026-08-21",
  },
  paddle: {
    blurb:
      "Paddle sends webhooks for transactions, subscriptions, customers, and adjustments in Paddle Billing.",
    configHint: "Paddle Dashboard → Developer Tools → Notifications → New destination",
    category: "Payments & billing",
    updated: "2026-08-21",
  },
  linear: {
    blurb: "Linear sends webhooks for issue, comment, project, and cycle changes in a workspace.",
    configHint: "Linear → Settings → API → Webhooks → New webhook",
    category: "Commerce & SaaS",
    updated: "2026-08-21",
  },
  sendgrid: {
    blurb:
      "SendGrid sends event webhooks for email delivery, opens, clicks, bounces, and spam reports.",
    configHint: "SendGrid → Settings → Mail Settings → Event Webhook",
    category: "Communication",
    updated: "2026-08-21",
  },
  clerk: {
    blurb:
      "Clerk sends webhooks for user, session, and organization lifecycle events, signed with Svix-style headers.",
    configHint: "Clerk Dashboard → Webhooks → Add endpoint",
    category: "Identity & data",
    updated: "2026-08-21",
  },
  discord: {
    blurb:
      "Discord sends interaction webhooks for slash commands and message components to your interactions endpoint URL.",
    configHint:
      "Discord Developer Portal → your app → General Information → Interactions Endpoint URL",
    category: "Communication",
    updated: "2026-08-21",
  },
  vercel: {
    blurb:
      "Vercel sends webhooks for deployment lifecycle events — created, succeeded, failed — across your projects.",
    configHint: "Vercel Dashboard → Team Settings → Webhooks",
    category: "Dev & deploy",
    updated: "2026-08-21",
  },
  gitlab: {
    blurb:
      "GitLab sends webhooks for pushes, merge requests, pipelines, issues, and tag events on projects and groups.",
    configHint: "Project → Settings → Webhooks",
    category: "Dev & deploy",
    updated: "2026-08-21",
  },
  typeform: {
    blurb: "Typeform sends webhooks each time someone submits (or partially completes) a form.",
    configHint: "Typeform → your form → Connect → Webhooks",
    category: "Commerce & SaaS",
    updated: "2026-08-21",
  },
  "standard-webhooks": {
    blurb:
      "Standard Webhooks is an open specification for webhook signing and delivery adopted by providers like Svix, Clerk, and Resend.",
    configHint: "Any provider implementing the Standard Webhooks spec",
    category: "Identity & data",
    updated: "2026-08-21",
  },
  meta: {
    blurb:
      "Meta sends webhooks for WhatsApp messages, Facebook Page events, and Instagram comments through the Graph API.",
    configHint: "Meta for Developers → your app → Webhooks → Edit subscription",
    category: "Communication",
    updated: "2026-08-21",
  },
  lemonsqueezy: {
    blurb:
      "Lemon Squeezy sends webhooks for orders, subscriptions, and license key events in your store.",
    configHint: "Lemon Squeezy → Settings → Webhooks",
    category: "Payments & billing",
    updated: "2026-08-21",
  },
  "coinbase-commerce": {
    blurb:
      "Coinbase Commerce sends webhooks as crypto charges are created, pending, confirmed, or failed.",
    configHint: "Coinbase Commerce → Settings → Webhook subscriptions",
    category: "Payments & billing",
    updated: "2026-08-21",
  },
  razorpay: {
    blurb:
      "Razorpay sends webhooks for payments, orders, settlements, refunds, and subscription events.",
    configHint: "Razorpay Dashboard → Account & Settings → Webhooks",
    category: "Payments & billing",
    updated: "2026-08-21",
  },
  cal: {
    blurb:
      "Cal.com sends webhooks when bookings are created, cancelled, rescheduled, or completed.",
    configHint: "Cal.com → Settings → Developer → Webhooks",
    category: "Commerce & SaaS",
    updated: "2026-08-21",
  },
  intercom: {
    blurb:
      "Intercom sends webhooks for conversations, contacts, and admin replies in your workspace.",
    configHint: "Intercom Developer Hub → your app → Webhooks",
    category: "Communication",
    updated: "2026-08-21",
  },
  telegram: {
    blurb:
      "Telegram bots receive updates — messages, callback queries, edits — via a webhook URL registered with setWebhook.",
    configHint: "Bot API → call setWebhook with your endpoint URL",
    category: "Communication",
    updated: "2026-08-21",
  },
  square: {
    blurb: "Square sends webhooks for payments, refunds, orders, inventory, and catalog changes.",
    configHint: "Square Developer Dashboard → your app → Webhooks → Subscriptions",
    category: "Payments & billing",
    updated: "2026-08-21",
  },
  hubspot: {
    blurb:
      "HubSpot sends webhooks for CRM object changes — contact creation, property changes, deal updates.",
    configHint: "HubSpot developer account → your app → Webhooks",
    category: "Commerce & SaaS",
    updated: "2026-08-21",
  },
  mailgun: {
    blurb: "Mailgun sends webhooks for email delivery, failures, opens, clicks, and unsubscribes.",
    configHint: "Mailgun → Sending → Webhooks",
    category: "Communication",
    updated: "2026-08-21",
  },
  calendly: {
    blurb: "Calendly sends webhooks when invitees schedule, cancel, or submit routing forms.",
    configHint: "Calendly API → create a webhook subscription (or Integrations page on paid plans)",
    category: "Commerce & SaaS",
    updated: "2026-08-21",
  },
  mux: {
    blurb:
      "Mux sends webhooks for video asset lifecycle events — uploads, processing, ready states, and live streams.",
    configHint: "Mux Dashboard → Settings → Webhooks",
    category: "Dev & deploy",
    updated: "2026-08-21",
  },
  sentry: {
    blurb:
      "Sentry sends webhooks for issues, errors, and alert rule triggers via internal integrations.",
    configHint: "Sentry → Settings → Developer Settings → your integration → Webhook URL",
    category: "Dev & deploy",
    updated: "2026-08-21",
  },
  bitbucket: {
    blurb:
      "Bitbucket sends webhooks for pushes, pull requests, and pipeline events on repositories.",
    configHint: "Repository → Settings → Webhooks → Add webhook",
    category: "Dev & deploy",
    updated: "2026-08-21",
  },
  docusign: {
    blurb:
      "DocuSign Connect sends webhooks as envelopes are sent, viewed, signed, completed, or declined.",
    configHint: "DocuSign Admin → Integrations → Connect → Add Configuration",
    category: "Identity & data",
    updated: "2026-08-21",
  },
  adyen: {
    blurb:
      "Adyen sends standard notification webhooks for authorisations, captures, refunds, and chargebacks.",
    configHint: "Adyen Customer Area → Developers → Webhooks → Create webhook",
    category: "Payments & billing",
    updated: "2026-08-21",
  },
  paypal: {
    blurb:
      "PayPal sends webhooks for captures, checkout orders, subscriptions, and disputes in your REST app.",
    configHint: "PayPal Developer Dashboard → your app → Webhooks → Add webhook",
    category: "Payments & billing",
    updated: "2026-08-21",
  },
  plaid: {
    blurb:
      "Plaid sends webhooks for transactions updates, item status changes, and auth events, verified with signed JWTs.",
    configHint: "Set the webhook URL when creating a Link token (or via /item/webhook/update)",
    category: "Identity & data",
    updated: "2026-08-21",
  },
  resend: {
    blurb:
      "Resend sends webhooks for email events such as sent, delivered, opened, clicked, bounced, and complained, plus domain and contact changes.",
    configHint: "Dashboard → Webhooks, or via the Webhooks API",
    category: "Communication",
    updated: "2026-10-02",
  },
  workos: {
    blurb:
      "WorkOS sends webhooks for authentication, user, session, organization, SSO connection, directory sync, and invitation events.",
    configHint: "Dashboard → Webhooks",
    category: "Identity & data",
    updated: "2026-10-02",
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

/**
 * Providers with a page but no SDK template: webhooks.cc captures their
 * webhooks like any other, it just cannot send signed samples or verify their
 * signatures. Adding one here is a content change only; a full provider
 * (templates, verification) still goes through the SDK catalog. Every fact
 * below is taken from the provider's own developer docs.
 */
interface CaptureOnlyProvider extends ProviderEditorial {
  label: string;
  signatureHeader: string | null;
  signatureAlgorithm: string | null;
  /** How the provider authenticates deliveries, when it is not a plain signature header. */
  signatureNote: string | null;
  /** True when the header is only sent once the user turns signing or auth on. */
  signatureOptional?: boolean;
}

const CAPTURE_ONLY_PROVIDERS: Record<string, CaptureOnlyProvider> = {
  airtable: {
    label: "Airtable",
    blurb:
      "Airtable sends webhook notifications when records, fields, or tables change in a base; the change payloads are then fetched through the API.",
    configHint: "Set via the Webhooks API (POST /v0/bases/{baseId}/webhooks)",
    category: "Identity & data",
    updated: "2026-09-29",
    signatureHeader: "x-airtable-content-mac",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "The notification is only a ping with the base and webhook IDs; read the changes from the list webhook payloads endpoint. The MAC is hmac-sha256=<hex>, keyed with the base64-decoded macSecret.",
  },
  auth0: {
    label: "Auth0",
    blurb:
      "Auth0 sends webhooks for tenant log events through Custom Webhook log streams, and for user lifecycle events such as user.created and user.deleted through Event Streams.",
    configHint: "Dashboard → Monitoring → Streams → Custom Webhook",
    category: "Identity & data",
    updated: "2026-09-29",
    signatureHeader: null,
    signatureAlgorithm: null,
    signatureNote:
      "Auth0 does not sign payloads. Log streams send an optional static Authorization header value, Event Streams support bearer token auth, and log stream payloads are JSON lines.",
  },
  "aws-sns": {
    label: "Amazon SNS",
    blurb:
      "Amazon SNS sends webhooks for each message published to a subscribed topic, plus SubscriptionConfirmation and UnsubscribeConfirmation messages.",
    configHint:
      "SNS console → Subscriptions → Create subscription (protocol HTTP or HTTPS), or the Subscribe API",
    category: "Dev & deploy",
    updated: "2026-10-02",
    signatureHeader: null,
    signatureAlgorithm: "RSA-SHA1",
    signatureNote:
      "Signed in the JSON body, not a header: a base64 RSA Signature (SHA1 for SignatureVersion 1, the default; SHA256 for 2) over newline-separated field names and values. Fetch SigningCertURL only if it is an HTTPS sns.*.amazonaws.com URL, and GET SubscribeURL only after the signature verifies.",
  },
  bigcommerce: {
    label: "BigCommerce",
    blurb: "BigCommerce sends webhooks for order, product, cart, and customer events in a store.",
    configHint: "Set via the Webhooks API (POST /stores/{store_hash}/v3/hooks)",
    category: "Commerce & SaaS",
    updated: "2026-09-29",
    signatureHeader: "webhook-signature",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "Signed with the app client secret following the Standard Webhooks protocol, which uses the webhook-id, webhook-timestamp, and webhook-signature headers.",
  },
  "bill-com": {
    label: "BILL",
    blurb:
      "BILL sends webhooks for bill, payment, vendor, and spend transaction events, such as bill.created, bill.updated, and spend.transaction.updated.",
    configHint: "Set via the Subscriptions API (POST /v3/subscriptions)",
    category: "Payments & billing",
    updated: "2026-09-29",
    signatureHeader: "x-bill-sha-signature",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "A base64-encoded HMAC of the minified JSON payload, keyed with the one-time securityKey returned when the subscription is created.",
  },
  bitgo: {
    label: "BitGo",
    blurb:
      "BitGo sends webhooks for wallet transfers, transactions, pending approvals, address confirmations, block confirmations, and enterprise events.",
    configHint:
      "Set via the Webhooks API (POST /api/v2/{coin}/wallet/{walletId}/webhooks for wallet webhooks)",
    category: "Payments & billing",
    updated: "2026-09-29",
    signatureHeader: "x-signature-sha256",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "The secret comes from BitGo's create webhook secret endpoint, and BitGo also offers a verify webhook notification endpoint.",
  },
  chargebee: {
    label: "Chargebee",
    blurb:
      "Chargebee sends webhooks for subscription, customer, invoice, payment, order, quote, and credit note events.",
    configHint: "Settings → Configure Chargebee → API Keys and Webhooks → Webhooks",
    category: "Payments & billing",
    updated: "2026-10-02",
    signatureHeader: "authorization",
    signatureAlgorithm: "Basic auth",
    signatureNote:
      "Chargebee does not sign payloads. Protect the URL with optional HTTP Basic auth, and confirm each event by fetching it again through the Events API.",
    signatureOptional: true,
  },
  "checkout-com": {
    label: "Checkout.com",
    blurb:
      "Checkout.com sends webhooks for payment lifecycle events such as approvals, captures, refunds, and voids, plus dispute events.",
    configHint: "Dashboard → Developers → Webhooks, or the Workflows API (POST /workflows)",
    category: "Payments & billing",
    updated: "2026-09-29",
    signatureHeader: "cko-signature",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "A hex-encoded HMAC of the raw body, keyed with the signature key set on the workflow's webhook action.",
  },
  clicksign: {
    label: "Clicksign",
    blurb:
      "Clicksign sends webhooks for document events such as upload, sign, close, deadline, and cancel.",
    configHint: "Settings (Configurações) → API → Add Webhook, or register through the API",
    category: "Identity & data",
    updated: "2026-09-29",
    signatureHeader: "content-hmac",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "The header value is sha256=<hex>, computed over the raw request body with the secret generated when the webhook is registered.",
  },
  contentful: {
    label: "Contentful",
    blurb:
      "Contentful sends webhooks for entry, asset, and content type events such as create, save, publish, unpublish, archive, and delete.",
    configHint: "Space settings → Webhooks",
    category: "Commerce & SaaS",
    updated: "2026-09-29",
    signatureHeader: "x-contentful-signature",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "Opt in with a webhook signing secret on the space. The signature covers a canonical request built from the headers listed in x-contentful-signed-headers, including x-contentful-timestamp.",
  },
  "customer-io": {
    label: "Customer.io",
    blurb:
      "Customer.io sends reporting webhooks for message sends, deliveries, opens, clicks, conversions, bounces, and failures across channels, plus subscription changes.",
    configHint:
      "Integrations → Reporting Webhooks → Add Reporting Webhook, or the App API (POST /v1/reporting_webhooks)",
    category: "Communication",
    updated: "2026-10-02",
    signatureHeader: "x-cio-signature",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "A hex-encoded HMAC of v0:{x-cio-timestamp}:{raw body}, keyed with the signing key shown on the Reporting Webhooks page.",
  },
  datadog: {
    label: "Datadog",
    blurb:
      "Datadog sends webhooks for monitor alerts, such as metric, log, synthetics, RUM, and SLO alerts, plus incident, case, and security signal notifications.",
    configHint:
      "Integrations → Webhooks tile → Configuration, then mention @webhook-<name> in a monitor message",
    category: "Dev & deploy",
    updated: "2026-10-02",
    signatureHeader: null,
    signatureAlgorithm: "Basic auth",
    signatureNote:
      "Datadog does not sign payloads. It supports Basic auth credentials in the webhook URL, custom headers such as a shared token, and an OAuth 2.0 client credentials Auth Method that adds a Bearer token.",
  },
  flutterwave: {
    label: "Flutterwave",
    blurb:
      "Flutterwave sends webhooks for charges, transfers, subscription cancellations, BVN verification, and bill payments.",
    configHint: "Dashboard → Settings → Webhooks",
    category: "Payments & billing",
    updated: "2026-09-29",
    signatureHeader: "verif-hash",
    signatureAlgorithm: null,
    signatureNote:
      "Not an HMAC: the secret hash set in the dashboard is sent as-is in the verif-hash header, and your handler compares it with its stored value.",
  },
  jira: {
    label: "Jira",
    blurb:
      "Jira sends webhooks for issue, comment, worklog, attachment, sprint, version, project, board, and user events.",
    configHint: "Settings → System → WebHooks, or via the Jira REST API",
    category: "Dev & deploy",
    updated: "2026-10-02",
    signatureHeader: "x-hub-signature",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "Signing is optional and applies only when a secret is set on an admin webhook. The value has the WebSub form method=signature.",
    signatureOptional: true,
  },
  juspay: {
    label: "Juspay",
    blurb:
      "Juspay sends webhooks for order, refund, transaction, chargeback, customer, mandate, and tokenization events.",
    configHint: "Juspay Dashboard → Payments → Settings → Webhooks",
    category: "Payments & billing",
    updated: "2026-09-29",
    signatureHeader: "authorization",
    signatureAlgorithm: "Basic auth",
    signatureNote:
      "Not a payload signature: you set a username and password in the Juspay dashboard, and Juspay sends them as an HTTP Basic Authorization header. Custom headers can be added as an extra check.",
  },
  loops: {
    label: "Loops",
    blurb:
      "Loops sends webhooks for contact and mailing list changes, email sends, and delivery, bounce, open, click, unsubscribe, and spam complaint events.",
    configHint: "Settings → Webhooks",
    category: "Communication",
    updated: "2026-10-02",
    signatureHeader: "webhook-signature",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "The header holds space-separated v1,{base64} entries, each an HMAC of {webhook-id}.{webhook-timestamp}.{raw body} keyed with the signing secret minus its whsec_ prefix, base64-decoded. After a secret roll, both secrets sign for 24 hours.",
  },
  mailchimp: {
    label: "Mailchimp",
    blurb:
      "Mailchimp sends webhooks for audience events such as subscribes, unsubscribes, profile and email changes, cleaned addresses, and campaign sends.",
    configHint: "Audience → Manage Audience → Settings → Webhooks → Create New Webhook",
    category: "Communication",
    updated: "2026-10-02",
    signatureHeader: "x-mailchimp-signature",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "Signing is optional and turned on per webhook. The header has the form t={timestamp},v1={hex}, and the HMAC covers {timestamp}.{raw_body}.",
    signatureOptional: true,
  },
  make: {
    label: "Make",
    blurb:
      "Make sends webhooks from scenarios through the HTTP app's Make a request module, which sends POST, PUT, PATCH, or other requests with data from earlier modules.",
    configHint: "Scenario → HTTP → Make a request → URL",
    category: "Commerce & SaaS",
    updated: "2026-10-02",
    signatureHeader: null,
    signatureAlgorithm: null,
    signatureNote:
      "Make does not sign requests. Make a request can attach an API key (header or query), Basic auth, or OAuth 2.0 credentials and present a client certificate over Mutual TLS, and Make publishes egress IPs per zone for allowlisting.",
  },
  mollie: {
    label: "Mollie",
    blurb:
      "Mollie sends webhooks for payment, refund, chargeback, order, subscription, payment link, payout, and invoice status changes.",
    configHint:
      "Per API resource via webhookUrl, or Dashboard → Developers → Webhooks for next-gen webhooks",
    category: "Payments & billing",
    updated: "2026-09-29",
    signatureHeader: "x-mollie-signature",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "Only next-gen webhooks are signed, with a sha256=<hex> value. Classic webhooks post just a resource ID, and the handler fetches the resource through the API to read its status.",
  },
  netlify: {
    label: "Netlify",
    blurb:
      "Netlify sends webhooks for deploy events, including deploy started, succeeded, failed, deleted, locked, unlocked, and restored.",
    configHint: "Project configuration → Notifications → Deploy notifications → HTTP POST request",
    category: "Dev & deploy",
    updated: "2026-09-29",
    signatureHeader: "x-webhook-signature",
    signatureAlgorithm: "JWT (HS256)",
    signatureNote:
      "A JWS whose iss is netlify and whose sha256 claim holds the hex SHA-256 of the payload.",
  },
  notion: {
    label: "Notion",
    blurb:
      "Notion sends webhooks for page, database, data source, and comment events in workspaces an integration can access.",
    configHint: "Integration settings → Webhooks → Create subscription",
    category: "Commerce & SaaS",
    updated: "2026-09-29",
    signatureHeader: "x-notion-signature",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "Notion first sends a one-time verification request with a verification_token, which you paste back into the integration settings. That token is also the HMAC key for later deliveries.",
  },
  okta: {
    label: "Okta",
    blurb:
      "Okta sends webhooks for eligible System Log events through Event Hooks, such as user lifecycle changes, user sign-ins, and changes to Okta objects.",
    configHint:
      "Admin Console → Workflow → Event Hooks → Create Event Hook, or the Event Hooks API (POST /api/v1/eventHooks)",
    category: "Identity & data",
    updated: "2026-10-02",
    signatureHeader: "authorization",
    signatureAlgorithm: "Shared token",
    signatureNote:
      "Okta does not sign payloads. It sends a static secret in a header you name (usually Authorization, for example a Basic auth value). A one-time verification GET carries x-okta-verification-challenge; return its value in a JSON verification field.",
  },
  pagerduty: {
    label: "PagerDuty",
    blurb:
      "PagerDuty sends webhooks for incident events such as triggered, acknowledged, escalated, and resolved, plus service created, updated, and deleted events.",
    configHint:
      "Integrations → Generic Webhooks (v3) → New Webhook, or the REST API (POST /webhook_subscriptions)",
    category: "Dev & deploy",
    updated: "2026-10-02",
    signatureHeader: "x-pagerduty-signature",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "The value is v1={hex}, an HMAC of the raw body keyed with the secret PagerDuty returns when the subscription is created. During secret rotation the header carries several comma-separated v1 signatures; accept a match on any.",
  },
  paystack: {
    label: "Paystack",
    blurb:
      "Paystack sends webhooks for charges, transfers, subscriptions, invoices, refunds, and disputes.",
    configHint: "Dashboard → Settings → API Keys & Webhooks",
    category: "Payments & billing",
    updated: "2026-09-29",
    signatureHeader: "x-paystack-signature",
    signatureAlgorithm: "HMAC-SHA512",
    signatureNote: "Signed with your Paystack secret key rather than a separate webhook secret.",
  },
  postmark: {
    label: "Postmark",
    blurb:
      "Postmark sends webhooks for delivery, bounce, spam complaint, open, click, subscription change, and inbound email events.",
    configHint: "Servers → your server → Message Stream → Webhooks → Add webhook",
    category: "Communication",
    updated: "2026-09-29",
    signatureHeader: null,
    signatureAlgorithm: "Basic auth",
    signatureNote:
      "Postmark does not sign payloads. It recommends HTTP Basic auth credentials in the webhook URL plus allowlisting Postmark's IP ranges.",
  },
  salesforce: {
    label: "Salesforce",
    blurb:
      "Salesforce sends webhooks as outbound messages: SOAP notifications with selected record fields, triggered by flows, workflow rules, and approval processes.",
    configHint:
      "Setup → Outbound Messages → New Outbound Message, then add it to a flow or workflow rule",
    category: "Commerce & SaaS",
    updated: "2026-10-02",
    signatureHeader: null,
    signatureAlgorithm: "Mutual TLS",
    signatureNote:
      "Outbound messages are not signed. Check that the SOAP body's OrganizationId is yours, optionally require Salesforce's client certificate and allowlist its IP ranges, and answer with a SOAP notificationsResponse whose Ack is true.",
  },
  segment: {
    label: "Segment",
    blurb:
      "Segment sends webhooks for Track, Identify, Page, Screen, Group, and Alias calls from connected sources through its Webhooks (Actions) destination.",
    configHint: "Connections → Catalog → Webhooks (Actions), then set the URL in a mapping",
    category: "Identity & data",
    updated: "2026-10-02",
    signatureHeader: "x-signature",
    signatureAlgorithm: "HMAC-SHA1",
    signatureNote:
      "Only sent when a shared secret is set under Settings → Advanced Settings. The value is a hex HMAC of the JSON request body keyed with that secret; with batching enabled, Segment signs only the first event in the batch.",
    signatureOptional: true,
  },
  supabase: {
    label: "Supabase",
    blurb:
      "Supabase Database Webhooks send an HTTP request for INSERT, UPDATE, and DELETE events on Postgres tables.",
    configHint: "Dashboard → Integrations → Webhooks",
    category: "Dev & deploy",
    updated: "2026-09-29",
    signatureHeader: null,
    signatureAlgorithm: null,
    signatureNote:
      "Supabase does not sign Database Webhook requests. Add a custom header, such as a shared secret, to each webhook and check it in your handler.",
  },
  webflow: {
    label: "Webflow",
    blurb:
      "Webflow sends webhooks for form submissions, site publishes, page changes, CMS item changes, ecommerce orders and inventory, and comments.",
    configHint:
      "Site settings → Apps & integrations → Webhooks, or the Webhooks API (POST /sites/{site_id}/webhooks)",
    category: "Commerce & SaaS",
    updated: "2026-09-29",
    signatureHeader: "x-webflow-signature",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "Only webhooks created through the API with an OAuth app or a site token are signed, together with an x-webflow-timestamp header. Webhooks created in the dashboard are not signed.",
  },
  woocommerce: {
    label: "WooCommerce",
    blurb:
      "WooCommerce sends webhooks for order, product, customer, and coupon events, plus custom action topics.",
    configHint: "WooCommerce → Settings → Advanced → Webhooks",
    category: "Commerce & SaaS",
    updated: "2026-09-29",
    signatureHeader: "x-wc-webhook-signature",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote: "A base64-encoded HMAC of the payload, keyed with the webhook secret.",
  },
  yousign: {
    label: "Yousign",
    blurb:
      "Yousign sends webhooks for signature request, signer, approver, document verification, electronic seal, and workflow events.",
    configHint: "Yousign app → Developers → Webhooks → Create a Webhook",
    category: "Identity & data",
    updated: "2026-09-29",
    signatureHeader: "x-yousign-signature-256",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote: "A hex digest of the raw body with a sha256= prefix.",
  },
  zapier: {
    label: "Zapier",
    blurb:
      "Zapier sends webhooks from Zap actions: Webhooks by Zapier POST, PUT, and Custom Request steps deliver data from earlier Zap steps to any URL.",
    configHint: "Zap editor → Action → Webhooks by Zapier → POST, PUT, or Custom Request",
    category: "Commerce & SaaS",
    updated: "2026-10-02",
    signatureHeader: "authorization",
    signatureAlgorithm: "Basic auth",
    signatureNote:
      "Zapier does not sign payloads. Each action can add custom headers and HTTP Basic auth (username and password or API key); every request carries User-Agent: Zapier, and Professional and higher plans can send from static IP ranges.",
    signatureOptional: true,
  },
  zendesk: {
    label: "Zendesk",
    blurb:
      "Zendesk sends webhooks for ticket activity through triggers and automations, and for user, organization, and help center events.",
    configHint: "Admin Center → Apps and integrations → Webhooks → Create webhook",
    category: "Commerce & SaaS",
    updated: "2026-09-29",
    signatureHeader: "x-zendesk-webhook-signature",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "The signature is base64(HMAC-SHA256(timestamp + body)), with the timestamp from x-zendesk-webhook-signature-timestamp.",
  },
  zoom: {
    label: "Zoom",
    blurb:
      "Zoom sends webhooks for meeting, webinar, recording, chat, phone, user, and account events.",
    configHint: "Zoom App Marketplace → your app → Features → Event Subscriptions",
    category: "Communication",
    updated: "2026-09-29",
    signatureHeader: "x-zm-signature",
    signatureAlgorithm: "HMAC-SHA256",
    signatureNote:
      "The value is v0={hex}, computed over v0:{x-zm-request-timestamp}:{body} with the app's secret token. Zoom also sends an endpoint.url_validation challenge that your endpoint must answer.",
  },
};

export interface WebhookProviderPage {
  slug: string;
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
  /** How the provider authenticates deliveries, when it is not a plain signature header. */
  signatureNote: string | null;
  /** False for capture-only providers: no SDK templates and no signature verification. */
  inSdk: boolean;
  /** True when deliveries only carry the signature or auth header once the user configures it. */
  signatureOptional: boolean;
  /** When the page's content last changed; the sitemap lastmod. */
  lastModified: Date;
}

export const WEBHOOK_PROVIDER_SLUGS: readonly string[] = [
  ...TEMPLATE_PROVIDERS,
  ...Object.keys(CAPTURE_ONLY_PROVIDERS),
];

// All page data derives from static SDK metadata, so build it once at module
// load and serve lookups from a Map.
let pagesBySlug: ReadonlyMap<string, WebhookProviderPage> | null = null;

function getPagesBySlug(): ReadonlyMap<string, WebhookProviderPage> {
  if (!pagesBySlug) {
    pagesBySlug = new Map([
      ...TEMPLATE_PROVIDERS.map(
        (slug) => [slug as string, buildWebhookProviderPage(slug)] as const
      ),
      ...Object.entries(CAPTURE_ONLY_PROVIDERS).map(
        ([slug, provider]) => [slug, buildCaptureOnlyPage(slug, provider)] as const
      ),
    ]);
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
    signatureNote: null,
    inSdk: true,
    signatureOptional: false,
    lastModified: new Date(`${editorial.updated}T00:00:00.000Z`),
  };
}

function buildCaptureOnlyPage(slug: string, provider: CaptureOnlyProvider): WebhookProviderPage {
  return {
    slug,
    label: provider.label,
    blurb: provider.blurb,
    configHint: provider.configHint,
    category: provider.category,
    templates: [],
    defaultTemplate: null,
    signatureHeader: provider.signatureHeader,
    signatureAlgorithm: provider.signatureAlgorithm,
    signatureAlgorithmLabel: provider.signatureAlgorithm
      ? (ALGORITHM_LABELS[provider.signatureAlgorithm] ?? provider.signatureAlgorithm)
      : null,
    secretRequired: false,
    verifySupported: false,
    credentialLabel: "",
    signatureNote: provider.signatureNote,
    inSdk: false,
    signatureOptional: provider.signatureOptional ?? false,
    lastModified: new Date(`${provider.updated}T00:00:00.000Z`),
  };
}

/**
 * "a" or "an" for a provider label, by its first letter: "an Amazon SNS
 * webhook", "a Stripe webhook". No label starts with a "you"-sounding U.
 */
export function indefiniteArticle(label: string): "a" | "an" {
  return /^[aeiou]/i.test(label) ? "an" : "a";
}

export function getAllWebhookProviderPages(): readonly WebhookProviderPage[] {
  return [...getPagesBySlug().values()];
}

/** Newest provider page change: the /webhooks hub lists them all, so it changes with them. */
export function getWebhookProvidersLastModified(): Date {
  return getAllWebhookProviderPages().reduce(
    (latest, page) => (page.lastModified > latest ? page.lastModified : latest),
    new Date(0)
  );
}

export const WEBHOOK_PROVIDER_CATEGORIES: readonly WebhookProviderCategory[] = [
  "Payments & billing",
  "Dev & deploy",
  "Communication",
  "Commerce & SaaS",
  "Identity & data",
];
