import { TEMPLATE_METADATA, TEMPLATE_PROVIDERS, type TemplateProvider } from "@webhooks-cc/sdk";
import { getWebProviderCredentialLabel, getWebProviderInfo } from "./provider-catalog";
import { hasProviderTestSnippet, PROVIDER_TEST_SNIPPET_ADDED } from "./provider-test-snippet";

export type WebhookProviderCategory =
  "Payments & billing" | "Dev & deploy" | "Communication" | "Commerce & SaaS" | "Identity & data";

interface ProviderEditorial {
  /** What this provider's webhooks notify you about - one factual sentence. */
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
    updated: "2026-10-20",
  },
  linear: {
    blurb: "Linear sends webhooks for issue, comment, project, and cycle changes in a workspace.",
    configHint: "Linear → Settings → API → Webhooks → New webhook",
    category: "Commerce & SaaS",
    updated: "2026-10-20",
  },
  sendgrid: {
    blurb:
      "SendGrid sends event webhooks for email delivery, opens, clicks, bounces, and spam reports.",
    configHint: "SendGrid → Settings → Mail Settings → Event Webhook",
    category: "Communication",
    updated: "2026-10-20",
  },
  clerk: {
    blurb:
      "Clerk sends webhooks for user, session, and organization lifecycle events, signed with Svix-style headers.",
    configHint: "Clerk Dashboard → Webhooks → Add endpoint",
    category: "Identity & data",
    updated: "2026-10-13",
  },
  discord: {
    blurb:
      "Discord sends interaction webhooks for slash commands and message components to your interactions endpoint URL.",
    configHint:
      "Discord Developer Portal → your app → General Information → Interactions Endpoint URL",
    category: "Communication",
    updated: "2026-10-13",
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
    updated: "2026-10-13",
  },
  "coinbase-commerce": {
    blurb:
      "Coinbase Commerce sends webhooks as crypto charges are created, pending, confirmed, or failed.",
    configHint: "Coinbase Commerce → Settings → Webhook subscriptions",
    category: "Payments & billing",
    updated: "2026-10-20",
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
    updated: "2026-10-20",
  },
  intercom: {
    blurb:
      "Intercom sends webhooks for conversations, contacts, and admin replies in your workspace.",
    configHint: "Intercom Developer Hub → your app → Webhooks",
    category: "Communication",
    updated: "2026-10-20",
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
    updated: "2026-10-20",
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
    updated: "2026-10-13",
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
    updated: "2026-10-20",
  },
  adyen: {
    blurb:
      "Adyen sends standard notification webhooks for authorisations, captures, refunds, and chargebacks.",
    configHint: "Adyen Customer Area → Developers → Webhooks → Create webhook",
    category: "Payments & billing",
    updated: "2026-10-20",
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
    updated: "2026-10-03",
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
    updated: "2026-10-03",
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
    updated: "2026-10-03",
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
    updated: "2026-10-20",
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
    updated: "2026-10-03",
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

/**
 * Copy for pages whose searches ask for more than the generic page answers,
 * read off Search Console: "lemonsqueezy test cards" brought the Lemon Squeezy
 * page hundreds of impressions and no clicks, because the title promised only
 * a webhook tester. Facts come from the provider's own docs, linked in
 * `reference.source`.
 */
export interface ProviderSeo {
  /** Replaces the generated title. */
  title?: string;
  /** Replaces the generated meta description. */
  description?: string;
  /** A table shown above the FAQ, for facts searchers look up (test cards, event names). */
  reference?: {
    heading: string;
    intro: string;
    columns: readonly [string, string];
    /** The column holding literal values (card numbers, event names), set in monospace. */
    codeColumn: 0 | 1;
    rows: readonly (readonly [string, string])[];
    source: { label: string; href: string };
  };
  /** Questions added to the page FAQ and its FAQPage schema. */
  faq?: readonly { question: string; answer: string }[];
}

const PROVIDER_SEO: Partial<Record<string, ProviderSeo>> = {
  lemonsqueezy: {
    title: "Lemon Squeezy Test Cards & Webhook Tester (Free)",
    description:
      "Lemon Squeezy test card numbers for successful, declined, expired and 3D Secure payments, plus a free endpoint that captures the webhooks every test purchase fires.",
    reference: {
      heading: "Lemon Squeezy test cards",
      intro:
        "Use these in test mode with any future expiry date (such as 12/35), any three-digit CVC and any value in the other fields. Each test purchase fires the same webhooks a live one does.",
      columns: ["Card", "Number"],
      codeColumn: 1,
      rows: [
        ["Visa (succeeds)", "4242 4242 4242 4242"],
        ["Mastercard (succeeds)", "5555 5555 5555 4444"],
        ["American Express (succeeds)", "3782 822463 10005"],
        ["Insufficient funds (declined)", "4000 0000 0000 9995"],
        ["Expired card (declined)", "4000 0000 0000 0069"],
        ["3D Secure authentication", "4000 0027 6000 3184"],
      ],
      source: {
        label: "Lemon Squeezy test mode docs",
        href: "https://docs.lemonsqueezy.com/help/getting-started/test-mode",
      },
    },
    faq: [
      {
        question: "What card numbers work in Lemon Squeezy test mode?",
        answer:
          "4242 4242 4242 4242 (Visa), 5555 5555 5555 4444 (Mastercard) and 3782 822463 10005 (American Express) succeed. 4000 0000 0000 9995 is declined for insufficient funds, 4000 0000 0000 0069 as expired, and 4000 0027 6000 3184 asks for 3D Secure. Use any future expiry date and any three-digit CVC.",
      },
      {
        question: "Do Lemon Squeezy test purchases send webhooks?",
        answer:
          "Yes. In test mode webhooks fire for every event, as in live mode, and you can also simulate subscription webhooks from the Lemon Squeezy dashboard. Test and live webhooks are configured separately, so point the test-mode webhook at a webhooks.cc endpoint to see each payload, then add a live webhook for production.",
      },
    ],
  },
  clerk: {
    title: "Clerk Webhooks: Free Tester, Svix Signatures & Events",
    description:
      "Capture Clerk webhooks such as user.created on a free endpoint, check the svix-signature header, send signed sample events, and forward deliveries to localhost.",
    faq: [
      {
        question: "How do I verify a Clerk webhook?",
        answer:
          "Clerk delivers webhooks through Svix, so every request carries svix-id, svix-timestamp and svix-signature headers. In your handler, call verifyWebhook() from @clerk/backend/webhooks; it reads the signing secret from CLERK_WEBHOOK_SIGNING_SECRET, which you copy from the endpoint on the Webhooks page of the Clerk Dashboard. On webhooks.cc, add the same secret to the endpoint and every captured delivery is marked valid or invalid.",
      },
      {
        question: "Why do I get the same Clerk webhook twice?",
        answer:
          "Clerk retries each event until your endpoint returns a 2xx response or the retries run out, and every attempt for one event carries the same svix-id. Store the svix-id you have processed and skip repeats.",
      },
      {
        question: "Can I test Clerk webhooks without a public server?",
        answer:
          "Yes. Point the Clerk endpoint at a webhooks.cc URL to see each user.created or session.created payload as it arrives, and run whk tunnel <port> to forward the deliveries to your app on localhost.",
      },
    ],
  },
  discord: {
    title: "Discord Webhook Tester: Check URLs & Inspect Payloads",
    description:
      "Test Discord webhooks free: see the exact JSON your app sends before it reaches a channel, check whether a Discord webhook URL still works, and capture interaction webhooks.",
    faq: [
      {
        question: "How do I test what my app sends to a Discord webhook?",
        answer:
          "Swap the Discord webhook URL in your app for a webhooks.cc endpoint URL. Each message your app would have posted is captured with its full JSON body (content, embeds, username), so you can check the payload before it reaches a real channel. When it looks right, turn on forwarding to a Discord webhook URL to pass captured requests on to the channel.",
      },
      {
        question: "How do I check if a Discord webhook URL is valid?",
        answer:
          "Send a GET request to the webhook URL itself (https://discord.com/api/webhooks/{id}/{token}). Discord answers without any other authentication and returns the webhook object, with its name, channel and server ids, when the URL works. An error response means the webhook was deleted or the token is wrong.",
      },
      {
        question: "What is the difference between a Discord webhook and an interactions endpoint?",
        answer:
          "A channel webhook is a URL you post messages to. An interactions endpoint is a URL on your server that Discord calls for slash commands and buttons, signed with Ed25519 in the x-signature-ed25519 header. webhooks.cc can capture both: the messages your app posts, and the interactions Discord sends.",
      },
    ],
  },
  mux: {
    title: "Mux Webhooks: Events, mux-signature & Free Tester",
    description:
      "Capture Mux webhooks such as video.asset.ready on a free endpoint, check the mux-signature header, send sample events, and forward deliveries to localhost.",
    reference: {
      heading: "Common Mux webhook events",
      intro:
        "Mux names events after the object they describe. These are the ones most integrations handle first.",
      columns: ["Event", "When it fires"],
      codeColumn: 0,
      rows: [
        ["video.asset.ready", "An asset finished processing and can be played"],
        ["video.asset.errored", "An asset failed to process"],
        ["video.asset.deleted", "An asset was deleted"],
        ["video.upload.asset_created", "A direct upload created its asset"],
        ["video.upload.errored", "A direct upload failed"],
        ["video.live_stream.active", "A live stream started receiving video"],
        ["video.live_stream.idle", "A live stream ended"],
      ],
      source: {
        label: "Mux webhook docs",
        href: "https://www.mux.com/docs/core/listen-for-webhooks",
      },
    },
    faq: [
      {
        question: "How do I verify Mux webhooks?",
        answer:
          "Mux signs every delivery with the mux-signature header. Set MUX_WEBHOOK_SECRET to the signing secret of your environment and call mux.webhooks.unwrap(body, headers, secret) from the Mux SDK, which verifies the signature and parses the event.",
      },
      {
        question: "Does Mux retry failed webhooks?",
        answer:
          "Yes. Without a 2xx response Mux retries for 24 hours with growing delays, and an attempt that takes longer than 5 seconds counts as failed. Deliveries can repeat even after a 2xx, so make your handler idempotent.",
      },
    ],
  },
  linear: {
    title: "Linear Webhooks: Events, linear-signature & Free Tester",
    description:
      "Inspect Linear webhook events (Issue, Comment, Project, Cycle), verify the linear-signature HMAC-SHA256 header, send signed samples, and forward to localhost.",
    reference: {
      heading: "Linear webhook events and headers",
      intro:
        "Linear sends a JSON body with action (create, update, remove), type, data, and webhookTimestamp, plus three identifying headers on every delivery.",
      columns: ["Header or resource type", "Purpose"],
      codeColumn: 0,
      rows: [
        ["linear-signature", "Hex HMAC-SHA256 digest of the raw request body"],
        ["linear-delivery", "UUID v4 unique to each webhook delivery attempt"],
        ["linear-event", "Entity type that changed (such as Issue or Comment)"],
        ["Issue", "Issue created, updated (state, assignee, priority), or removed"],
        ["Comment", "Comment posted, edited, or deleted on an issue"],
        ["Project", "Project or ProjectUpdate created, modified, or archived"],
        ["Cycle", "Cycle started, updated, or completed in a team"],
      ],
      source: {
        label: "Linear webhooks documentation",
        href: "https://linear.app/developers/webhooks",
      },
    },
    faq: [
      {
        question: "How do I verify Linear's linear-signature header?",
        answer:
          "Compute an HMAC-SHA256 hex digest over the raw request body using your webhook signing secret and compare it in constant time against the linear-signature header. Also check that payload.webhookTimestamp is within 60 seconds of the current time to prevent replay attacks.",
      },
      {
        question: "What is Linear's webhook retry schedule?",
        answer:
          "If your endpoint does not respond with HTTP 200 within 5 seconds, Linear retries the delivery up to 3 times after 1 minute, 1 hour, and 6 hours. If an endpoint fails repeatedly, Linear disables the webhook subscription automatically.",
      },
    ],
  },
  docusign: {
    title: "DocuSign Connect Webhooks: Events, HMAC & Best Practices",
    description:
      "Capture DocuSign Connect webhook events (envelope-sent, envelope-completed), verify x-docusign-signature-1 HMAC headers, and follow listener best practices.",
    reference: {
      heading: "Common DocuSign Connect webhook events",
      intro:
        "DocuSign Connect JSON SIM (Connect 2.0) notifications send an event string alongside envelopeId and data. Configure these events under DocuSign Admin -> Connect.",
      columns: ["Event", "When it fires"],
      codeColumn: 0,
      rows: [
        ["envelope-sent", "Envelope has been sent to at least one recipient"],
        ["envelope-delivered", "All recipients have opened the envelope"],
        ["envelope-completed", "All recipients have signed and completed the envelope"],
        ["envelope-declined", "A recipient declined to sign the envelope"],
        ["envelope-voided", "The sender voided the envelope"],
        ["recipient-completed", "An individual recipient finished signing"],
        ["recipient-authenticationfailed", "A recipient failed an identity or access-code check"],
      ],
      source: {
        label: "DocuSign Connect webhook docs",
        href: "https://developers.docusign.com/platform/webhooks/connect/",
      },
    },
    faq: [
      {
        question: "What are the DocuSign webhook listener best practices?",
        answer:
          "Acknowledge every delivery with HTTP 200 immediately before running slow tasks or downloading signed PDFs, verify the x-docusign-signature-1 base64 HMAC-SHA256 header against the raw body, deduplicate retries using envelopeId plus event timestamp, and omit Include Documents from the webhook payload so your worker fetches PDFs asynchronously via the eSignature REST API.",
      },
      {
        question: "How do I verify x-docusign-signature-1?",
        answer:
          "Enable HMAC security in your DocuSign Connect configuration and copy the HMAC key. Compute a base64-encoded HMAC-SHA256 digest of the raw UTF-8 request body using that key and compare it in constant time with x-docusign-signature-1.",
      },
    ],
  },
  sendgrid: {
    title: "SendGrid Event Webhook: ECDSA Signatures, Events & Tester",
    description:
      "Test SendGrid Event Webhook deliveries (delivered, open, bounce, spamreport), verify ECDSA signatures with x-twilio-email-event-webhook-signature, and replay.",
    reference: {
      heading: "SendGrid Event Webhook event types",
      intro:
        "SendGrid batches email events into a JSON array POSTed to your Event Webhook URL. Every object in the array carries an event field and sg_event_id.",
      columns: ["Event", "Meaning"],
      codeColumn: 0,
      rows: [
        ["processed", "Message received by SendGrid and ready for delivery"],
        ["delivered", "Receiving mail server accepted the message"],
        ["deferred", "Receiving server temporarily rejected the message; SendGrid will retry"],
        ["bounce", "Receiving server permanently rejected the message"],
        ["dropped", "SendGrid dropped the message (suppression list, invalid address)"],
        ["open", "Recipient opened the HTML email (tracking pixel loaded)"],
        ["click", "Recipient clicked a tracked link in the email"],
        ["spamreport", "Recipient marked the email as spam"],
      ],
      source: {
        label: "SendGrid Event Webhook reference",
        href: "https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event",
      },
    },
    faq: [
      {
        question: "How do I verify SendGrid's x-twilio-email-event-webhook-signature header?",
        answer:
          "SendGrid signs Event Webhooks with ECDSA over SHA-256 rather than HMAC. Concatenate the x-twilio-email-event-webhook-timestamp header value and the raw request body bytes, then verify the base64 signature in x-twilio-email-event-webhook-signature using the ECDSA public key from SendGrid Settings -> Mail Settings -> Event Webhook.",
      },
      {
        question: "Why does SendGrid send an array of events instead of a single JSON object?",
        answer:
          "SendGrid batches deliveries for throughput, posting a JSON array of event objects every few seconds or when the batch fills. Iterate over the array in your handler and deduplicate each item by its unique sg_event_id.",
      },
    ],
  },
  paddle: {
    title: "Paddle Webhooks: paddle-signature & p_signature Guide",
    description:
      "Verify Paddle Billing paddle-signature (ts;h1 HMAC-SHA256) and Paddle Classic p_signature (RSA-SHA1 phpserialize), inspect subscription events, and test locally.",
    reference: {
      heading: "Paddle Billing events and Classic signature headers",
      intro:
        "Paddle Billing sends JSON webhooks signed with paddle-signature. Legacy Paddle Classic sends URL-encoded form POSTs with a p_signature field inside the body.",
      columns: ["Event or field", "Description"],
      codeColumn: 0,
      rows: [
        ["paddle-signature", "Paddle Billing header: ts=<unix_timestamp>;h1=<hmac_sha256_hex>"],
        ["p_signature", "Paddle Classic form field: base64 RSA-SHA1 over PHP-serialized fields"],
        ["transaction.completed", "Paddle Billing transaction payment succeeded"],
        ["transaction.payment_failed", "Paddle Billing payment attempt failed"],
        ["subscription.created", "New subscription started in Paddle Billing"],
        ["subscription.updated", "Subscription plan, quantity, or billing cycle changed"],
        ["subscription.canceled", "Subscription canceled by customer or billing failure"],
      ],
      source: {
        label: "Paddle webhooks documentation",
        href: "https://developer.paddle.com/webhooks/overview",
      },
    },
    faq: [
      {
        question: "How do I verify paddle-signature in Paddle Billing?",
        answer:
          "Split the paddle-signature header on ';' to extract ts and h1. Build the signed payload string `${ts}:${rawBody}` using the exact raw request body, compute its hex HMAC-SHA256 digest with your endpoint's secret key (pdl_ntfset_...), and compare it to h1.",
      },
      {
        question: "How do I verify p_signature in Paddle Classic?",
        answer:
          "Parse the application/x-www-form-urlencoded body, extract and remove the p_signature field, sort the remaining keys alphabetically, stringify every value, serialize the sorted key-value map using PHP's serialize() format, and verify the base64 p_signature with RSA-SHA1 against your Paddle Classic public key.",
      },
    ],
  },
  intercom: {
    title: "Intercom Webhooks: x-hub-signature, Topics & Free Tester",
    description:
      "Capture Intercom webhook topics (conversation.user.created, conversation.admin.replied), verify x-hub-signature HMAC-SHA1 with your client secret, and test.",
    reference: {
      heading: "Common Intercom webhook topics",
      intro:
        "Intercom notifications wrap every event in a notification_event object whose topic field identifies what happened in your workspace.",
      columns: ["Topic", "When it fires"],
      codeColumn: 0,
      rows: [
        ["conversation.user.created", "A user or lead started a new conversation"],
        ["conversation.user.replied", "A user or lead replied to an existing conversation"],
        ["conversation.admin.replied", "A teammate or admin replied to a conversation"],
        ["conversation.admin.closed", "An admin closed a conversation"],
        ["contact.user.created", "A new user contact was created"],
        ["ticket.created", "A new support ticket was created"],
      ],
      source: {
        label: "Intercom webhooks documentation",
        href: "https://developers.intercom.com/docs/webhooks",
      },
    },
    faq: [
      {
        question: "How do I verify Intercom's x-hub-signature header?",
        answer:
          "Intercom signs the raw JSON body with HMAC-SHA1 using your Intercom app's client_secret and sends the result as sha1=<hex> in the x-hub-signature header. Compute sha1=<hex> over the unparsed request body with your client secret and compare in constant time.",
      },
      {
        question: "What happens if an Intercom webhook endpoint times out?",
        answer:
          "Your endpoint must return a 2xx status within 5 seconds. Failed or timed-out deliveries are retried with exponential backoff, and Intercom temporarily suspends the webhook subscription if failures persist.",
      },
    ],
  },
  square: {
    title: "Square Webhooks: HMAC-SHA256 Signatures, Events & Tester",
    description:
      "Test Square webhook events (payment.updated, order.created, invoice.payment_made), verify x-square-hmacsha256-signature over notificationUrl + body, and replay.",
    reference: {
      heading: "Common Square webhook events",
      intro:
        "Square webhooks carry event_id, type, merchant_id, and data. Subscribe to specific event types in the Square Developer Dashboard.",
      columns: ["Event", "When it fires"],
      codeColumn: 0,
      rows: [
        ["payment.created", "A new payment is initialized"],
        ["payment.updated", "A payment status changes (such as COMPLETED or FAILED)"],
        ["order.created", "A new order is created"],
        ["order.updated", "An order state, fulfillment, or line item changes"],
        ["refund.updated", "A payment refund completes or fails"],
        ["invoice.payment_made", "A customer pays a Square invoice"],
      ],
      source: {
        label: "Square webhooks overview",
        href: "https://developer.squareup.com/docs/webhooks/overview",
      },
    },
    faq: [
      {
        question: "Why does Square x-square-hmacsha256-signature verification fail?",
        answer:
          "Unlike providers that sign only the body, Square prepends your exact webhook notification URL to the raw UTF-8 body before hashing: base64(HMAC-SHA256(notificationUrl + rawBody, signatureKey)). If your app sits behind a proxy or trailing slash mismatch, pass the exact URL registered in the Square Developer Dashboard.",
      },
      {
        question: "How do I test Square webhooks on localhost?",
        answer:
          "Create a free webhooks.cc endpoint, paste its URL into Square Developer Dashboard -> Webhooks -> Subscriptions, and click Send Test Event or run whk tunnel <port> to forward live sandbox deliveries to your local server.",
      },
    ],
  },
  cal: {
    title: "Cal.com Webhooks: x-cal-signature-256, Triggers & Tester",
    description:
      "Capture Cal.com booking webhooks (BOOKING_CREATED, BOOKING_RESCHEDULED, BOOKING_CANCELLED), verify the x-cal-signature-256 HMAC-SHA256 header, and test locally.",
    reference: {
      heading: "Cal.com webhook trigger events",
      intro:
        "Cal.com webhooks send triggerEvent, createdAt, and payload with booking details, attendee emails, and custom responses.",
      columns: ["triggerEvent", "When it fires"],
      codeColumn: 0,
      rows: [
        ["BOOKING_CREATED", "An attendee schedules a new booking"],
        ["BOOKING_RESCHEDULED", "An existing booking is moved to a new time"],
        ["BOOKING_CANCELLED", "A booking is cancelled by attendee or host"],
        ["BOOKING_REJECTED", "A host rejects a booking request that required confirmation"],
        ["MEETING_ENDED", "A scheduled meeting's end time is reached"],
        ["RECORDING_READY", "A Cal Video recording is ready for download"],
      ],
      source: {
        label: "Cal.com webhooks guide",
        href: "https://cal.com/docs/developing/guides/automation/webhooks",
      },
    },
    faq: [
      {
        question: "How do I verify Cal.com's x-cal-signature-256 header?",
        answer:
          "When you set a Secret on a Cal.com webhook, Cal.com computes a hex-encoded HMAC-SHA256 digest of the raw request body using that secret and sends it in the x-cal-signature-256 header. Recompute HMAC-SHA256(rawBody, secret) in hex and compare with timingSafeEqual.",
      },
    ],
  },
  "coinbase-commerce": {
    title: "Coinbase Commerce Webhooks: x-cc-webhook-signature & Events",
    description:
      "Verify Coinbase Commerce x-cc-webhook-signature (HMAC-SHA256), inspect charge:created, charge:pending, and charge:confirmed payloads, and test on a free URL.",
    reference: {
      heading: "Coinbase Commerce webhook events",
      intro:
        "Coinbase Commerce wraps each notification in an event object with id, type, api_version, created_at, and data holding the charge resource.",
      columns: ["Event type", "When it fires"],
      codeColumn: 0,
      rows: [
        ["charge:created", "A new crypto checkout charge is created"],
        ["charge:pending", "A transaction is detected on-chain but not yet confirmed"],
        ["charge:confirmed", "On-chain payment reached the required block confirmations"],
        ["charge:failed", "Charge expired or payment failed to complete"],
        ["charge:delayed", "Payment was received after the charge expiration window"],
        ["charge:resolved", "An underpaid, overpaid, or delayed charge was resolved"],
      ],
      source: {
        label: "Coinbase Commerce webhooks docs",
        href: "https://docs.cdp.coinbase.com/commerce-onchain/docs/webhooks",
      },
    },
    faq: [
      {
        question: "How do I verify the x-cc-webhook-signature header?",
        answer:
          "Copy your Webhook Shared Secret from Coinbase Commerce Settings -> Notifications. Compute a lowercase hex HMAC-SHA256 digest over the raw request body using that shared secret and compare it in constant time with the x-cc-webhook-signature header.",
      },
      {
        question: "Should I fulfill orders on charge:pending or charge:confirmed?",
        answer:
          "Always wait for charge:confirmed before fulfilling an order or granting access. charge:pending only means a transaction was broadcast; it has not yet finalized on-chain.",
      },
    ],
  },
  adyen: {
    title: "Adyen Webhooks: hmacSignature Verification, Events & Tester",
    description:
      "Capture Adyen standard notification webhooks (AUTHORISATION, CAPTURE, REFUND, CHARGEBACK), verify additionalData.hmacSignature (HMAC-SHA256), and test locally.",
    reference: {
      heading: "Common Adyen standard webhook eventCodes",
      intro:
        'Adyen sends a notificationItems array where each NotificationRequestItem carries eventCode, success ("true" or "false"), pspReference, and additionalData.hmacSignature.',
      columns: ["eventCode", "Meaning"],
      codeColumn: 0,
      rows: [
        ["AUTHORISATION", "Payment authorization succeeded or failed (check success field)"],
        ["CAPTURE", "Authorized payment funds were captured"],
        ["CANCELLATION", "Authorized payment was cancelled before capture"],
        ["REFUND", "Captured payment was refunded to the shopper"],
        ["CHARGEBACK", "Shopper disputed the charge and funds were deducted"],
        ["REPORT_AVAILABLE", "A settlement or accounting report is ready to download"],
      ],
      source: {
        label: "Adyen webhooks documentation",
        href: "https://docs.adyen.com/development-resources/webhooks",
      },
    },
    faq: [
      {
        question: "How do I verify Adyen's hmacSignature?",
        answer:
          "For standard webhooks, Adyen places the signature inside notificationItem.NotificationRequestItem.additionalData.hmacSignature. Join pspReference, originalReference, merchantAccountCode, merchantReference, amount.value, amount.currency, eventCode, and success with ':' (escaping '\\' as '\\\\' and ':' as '\\:'), hex-decode your Adyen HMAC key into binary bytes, and compute a base64 HMAC-SHA256 digest.",
      },
      {
        question: "What response does Adyen expect from a webhook endpoint?",
        answer:
          "Adyen requires a 2xx HTTP status (or '[accepted]' on older configurations) within 10 seconds. Always verify hmacSignature and check whether success equals 'true' before fulfilling an AUTHORISATION event.",
      },
    ],
  },
  "checkout-com": {
    title: "Checkout.com Webhooks: cko-signature, Events & Free Tester",
    description:
      "Test Checkout.com workflow webhooks (payment_approved, payment_captured, payment_refunded), verify the cko-signature HMAC-SHA256 header, and inspect payloads.",
    reference: {
      heading: "Common Checkout.com webhook events",
      intro:
        "Checkout.com Workflows send JSON notifications with id, type, created_on, and data, signed in the cko-signature header.",
      columns: ["Event type", "When it fires"],
      codeColumn: 0,
      rows: [
        ["payment_approved", "Payment authorization was approved by the issuer"],
        ["payment_declined", "Payment authorization was declined"],
        ["payment_captured", "Authorized payment was captured"],
        ["payment_refunded", "Captured payment was refunded"],
        ["payment_voided", "Authorized payment was voided before capture"],
        ["dispute_received", "Cardholder opened a chargeback dispute"],
      ],
      source: {
        label: "Checkout.com webhooks documentation",
        href: "https://www.checkout.com/docs/developer-resources/webhooks",
      },
    },
    faq: [
      {
        question: "How do I verify Checkout.com's cko-signature header?",
        answer:
          "Each webhook action in a Checkout.com Workflow has a signature key. Compute a lowercase hex HMAC-SHA256 digest of the raw request body using that signature key and compare it with the cko-signature header. You can also configure an optional Authorization header on the workflow.",
      },
      {
        question: "How does Checkout.com retry failed webhooks?",
        answer:
          "If your endpoint does not return a 2xx response within 10 seconds, Checkout.com Workflows retry the webhook with exponential backoff for up to 24 hours. Use the event id field to deduplicate repeated deliveries.",
      },
    ],
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
  seo: ProviderSeo | null;
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
  // metadata lacks - e.g. Discord verifies with the x-signature-ed25519 header
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

  const label = info?.label ?? provider;
  const defaultTemplate = "defaultTemplate" in meta ? meta.defaultTemplate : null;
  // A page that shows the CI test snippet changed when the snippet arrived.
  const showsSnippet = hasProviderTestSnippet({
    slug: provider,
    label,
    inSdk: true,
    secretRequired: meta.secretRequired,
    defaultTemplate,
  });
  const updated =
    showsSnippet && PROVIDER_TEST_SNIPPET_ADDED > editorial.updated
      ? PROVIDER_TEST_SNIPPET_ADDED
      : editorial.updated;

  return {
    slug: provider,
    label,
    blurb: editorial.blurb,
    configHint: editorial.configHint,
    category: editorial.category,
    templates: meta.templates,
    defaultTemplate,
    signatureHeader,
    signatureAlgorithm: resolvedAlgorithm,
    signatureAlgorithmLabel,
    secretRequired: meta.secretRequired,
    verifySupported: info?.verificationMode === "secret" || info?.verificationMode === "publicKey",
    credentialLabel: getWebProviderCredentialLabel(provider),
    signatureNote: null,
    inSdk: true,
    signatureOptional: false,
    lastModified: new Date(`${updated}T00:00:00.000Z`),
    seo: PROVIDER_SEO[provider] ?? null,
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
    seo: PROVIDER_SEO[slug] ?? null,
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
