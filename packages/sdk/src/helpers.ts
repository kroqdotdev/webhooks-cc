import type {
  DetectedWebhookInfo,
  ParsedBody,
  ParsedFormBody,
  Request,
  SearchResult,
  TemplateProvider,
} from "./types";

type RequestLike = Pick<Request, "headers" | "body" | "contentType">;
type SearchLike = Pick<SearchResult, "headers" | "body" | "contentType">;
type WebhookLike = RequestLike | SearchLike;

function getHeaderValue(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function getContentType(request: WebhookLike): string | undefined {
  return request.contentType ?? getHeaderValue(request.headers, "content-type");
}

function normalizeContentType(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.split(";", 1)[0]?.trim().toLowerCase();
}

function getJsonPathValue(body: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = body;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (typeof current !== "object") {
      return undefined;
    }

    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Safely parse a JSON request body.
 * Returns undefined if the body is empty or not valid JSON.
 */
export function parseJsonBody(request: Pick<WebhookLike, "body">): unknown | undefined {
  if (!request.body) return undefined;
  try {
    return JSON.parse(request.body);
  } catch {
    return undefined;
  }
}

/**
 * Check if a request looks like a Stripe webhook.
 * Matches on the `stripe-signature` header being present.
 */
export function isStripeWebhook(request: Request): boolean {
  return isDetectedProvider(request, "stripe");
}

/**
 * Check if a request looks like a GitHub webhook.
 * Matches on the `x-github-event` header being present.
 */
export function isGitHubWebhook(request: Request): boolean {
  return isDetectedProvider(request, "github");
}

/**
 * Returns a match function that checks whether a JSON field in the
 * request body equals the expected value.
 *
 * @example
 * ```ts
 * const req = await client.requests.waitFor(slug, {
 *   match: matchJsonField("type", "checkout.session.completed"),
 * });
 * ```
 */
export function matchJsonField(field: string, value: unknown): (request: Request) => boolean {
  return (request: Request) => {
    const body = parseJsonBody(request);
    if (typeof body !== "object" || body === null) return false;
    if (!Object.prototype.hasOwnProperty.call(body, field)) return false;
    return (body as Record<string, unknown>)[field] === value;
  };
}

/**
 * Parse an application/x-www-form-urlencoded request body.
 * Repeated keys are returned as string arrays.
 */
export function parseFormBody(request: WebhookLike): ParsedFormBody | undefined {
  if (!request.body) {
    return undefined;
  }

  const contentType = normalizeContentType(getContentType(request));
  if (contentType !== "application/x-www-form-urlencoded") {
    return undefined;
  }

  const parsed: ParsedFormBody = {};
  for (const [key, value] of new URLSearchParams(request.body).entries()) {
    const existing = parsed[key];
    if (existing === undefined) {
      parsed[key] = value;
      continue;
    }
    if (Array.isArray(existing)) {
      existing.push(value);
      continue;
    }
    parsed[key] = [existing, value];
  }

  return parsed;
}

/**
 * Parse the request body based on content-type.
 * JSON and urlencoded bodies are decoded; other bodies are returned as raw text.
 */
export function parseBody(request: WebhookLike): ParsedBody {
  if (!request.body) {
    return undefined;
  }

  const contentType = normalizeContentType(getContentType(request));
  if (contentType === "application/json" || contentType?.endsWith("+json")) {
    const parsed = parseJsonBody(request);
    return parsed === undefined ? request.body : parsed;
  }

  if (contentType === "application/x-www-form-urlencoded") {
    return parseFormBody(request);
  }

  return request.body;
}

/**
 * Extract a nested JSON field from the request body using dot notation.
 * Returns undefined if the body is missing, invalid JSON, or the path is absent.
 */
export function extractJsonField<T>(
  request: Pick<WebhookLike, "body">,
  path: string
): T | undefined {
  const body = parseJsonBody(request);
  if (body === undefined) {
    return undefined;
  }
  return getJsonPathValue(body, path) as T | undefined;
}

/** Check if a request looks like a Shopify webhook. */
export function isShopifyWebhook(request: Request): boolean {
  return isDetectedProvider(request, "shopify");
}

/** Check if a request looks like a Slack webhook. */
export function isSlackWebhook(request: Request): boolean {
  return isDetectedProvider(request, "slack");
}

/** Check if a request looks like a Twilio webhook. */
export function isTwilioWebhook(request: Request): boolean {
  return isDetectedProvider(request, "twilio");
}

/** Check if a request looks like a Paddle webhook. */
export function isPaddleWebhook(request: Request): boolean {
  return isDetectedProvider(request, "paddle");
}

/** Check if a request looks like a Linear webhook. */
export function isLinearWebhook(request: Request): boolean {
  return isDetectedProvider(request, "linear");
}

/** Check if a request looks like a Discord interaction webhook. */
export function isDiscordWebhook(request: Request): boolean {
  return isDetectedProvider(request, "discord");
}

/**
 * Check if a request looks like a SendGrid event webhook.
 * Matches on the body being a JSON array with an sg_event_id field.
 */
export function isSendGridWebhook(request: Request): boolean {
  return isDetectedProvider(request, "sendgrid");
}

/**
 * Check if a request looks like a Clerk webhook.
 * Matches on the `svix-id` header being present.
 */
export function isClerkWebhook(request: Request): boolean {
  return isDetectedProvider(request, "clerk");
}

/**
 * Check if a request looks like a Vercel webhook.
 * Matches on the `x-vercel-signature` header being present.
 */
export function isVercelWebhook(request: Request): boolean {
  return isDetectedProvider(request, "vercel");
}

/**
 * Check if a request looks like a GitLab webhook.
 * Matches on the `x-gitlab-event` or `x-gitlab-token` header being present.
 */
export function isGitLabWebhook(request: Request): boolean {
  return isDetectedProvider(request, "gitlab");
}

/** Check if a request looks like a Typeform webhook. */
export function isTypeformWebhook(request: Request): boolean {
  return isDetectedProvider(request, "typeform");
}

/**
 * Check if a request looks like a Standard Webhooks request.
 * Matches on the presence of all three Standard Webhooks headers:
 * webhook-id, webhook-timestamp, and webhook-signature.
 */
export function isStandardWebhook(request: Request): boolean {
  return isDetectedProvider(request, "standard-webhooks");
}

/** Check if a request looks like a Meta (WhatsApp/Messenger/Instagram) webhook. */
export function isMetaWebhook(request: Request): boolean {
  return isDetectedProvider(request, "meta");
}

/** Check if a request looks like a Lemon Squeezy webhook. */
export function isLemonSqueezyWebhook(request: Request): boolean {
  return isDetectedProvider(request, "lemonsqueezy");
}

/** Check if a request looks like a Coinbase Commerce webhook. */
export function isCoinbaseCommerceWebhook(request: Request): boolean {
  return isDetectedProvider(request, "coinbase-commerce");
}

/** Check if a request looks like a Razorpay webhook. */
export function isRazorpayWebhook(request: Request): boolean {
  return isDetectedProvider(request, "razorpay");
}

/** Check if a request looks like a Cal.com webhook. */
export function isCalWebhook(request: Request): boolean {
  return isDetectedProvider(request, "cal");
}

/** Check if a request looks like an Intercom webhook. */
export function isIntercomWebhook(request: Request): boolean {
  return isDetectedProvider(request, "intercom");
}

/** Check if a request looks like a Telegram webhook. */
export function isTelegramWebhook(request: Request): boolean {
  return isDetectedProvider(request, "telegram");
}

/** Check if a request looks like a Square webhook. */
export function isSquareWebhook(request: Request): boolean {
  return isDetectedProvider(request, "square");
}

/** Check if a request looks like a HubSpot webhook. */
export function isHubSpotWebhook(request: Request): boolean {
  return isDetectedProvider(request, "hubspot");
}

/** Check if a request looks like a Mailgun webhook. */
export function isMailgunWebhook(request: Request): boolean {
  return isDetectedProvider(request, "mailgun");
}

/** Check if a request looks like a Calendly webhook. */
export function isCalendlyWebhook(request: Request): boolean {
  return isDetectedProvider(request, "calendly");
}

/** Check if a request looks like a Mux webhook. */
export function isMuxWebhook(request: Request): boolean {
  return isDetectedProvider(request, "mux");
}

/** Check if a request looks like a Sentry webhook. */
export function isSentryWebhook(request: Request): boolean {
  return isDetectedProvider(request, "sentry");
}

/** Check if a request looks like a Bitbucket webhook. */
export function isBitbucketWebhook(request: Request): boolean {
  return isDetectedProvider(request, "bitbucket");
}

function getEventString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getJsonObject(request: Pick<WebhookLike, "body">): Record<string, unknown> | null {
  const parsed = parseJsonBody(request);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function getJsonArrayFirstObject(
  request: Pick<WebhookLike, "body">
): Record<string, unknown> | null {
  const parsed = parseJsonBody(request);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }

  const first = parsed[0];
  return first && typeof first === "object" && !Array.isArray(first)
    ? (first as Record<string, unknown>)
    : null;
}

function getFormFieldValue(request: WebhookLike, field: string): string | null {
  const parsed = parseFormBody(request);
  if (!parsed) {
    return null;
  }

  const value = parsed[field];
  if (typeof value === "string") {
    return getEventString(value);
  }

  if (Array.isArray(value)) {
    return getEventString(value[0]);
  }

  return null;
}

function normalizeGitLabEvent(event: string | undefined): string | null {
  if (!event) {
    return null;
  }

  const normalized = event.trim().toLowerCase();
  if (normalized === "push hook") {
    return "push";
  }
  if (normalized === "merge request hook") {
    return "merge_request";
  }
  return normalized.replace(/\s+hook$/, "").replace(/\s+/g, "_");
}

function extractLinearEvent(request: Pick<WebhookLike, "body">): string | null {
  const body = getJsonObject(request);
  const action = getEventString(body?.action);
  const type = getEventString(body?.type);

  if (!action || !type) {
    return null;
  }

  return `${type.toLowerCase()}.${action.toLowerCase()}`;
}

function extractDiscordEvent(request: Pick<WebhookLike, "body">): string | null {
  const body = getJsonObject(request);
  if (!body) {
    return null;
  }

  if (typeof body.type === "number") {
    if (body.type === 1) return "ping";
    if (body.type === 2) return "interaction_create";
    if (body.type === 3) return "message_component";
  }

  return getEventString(body.type);
}

type Detector = {
  provider: TemplateProvider;
  via: "header" | "body";
  matchedOn?: string;
  matches: (request: WebhookLike) => boolean;
  event: (request: WebhookLike) => string | null;
};

const DETECTORS: readonly Detector[] = [
  {
    provider: "stripe",
    via: "header",
    matchedOn: "stripe-signature",
    matches: (request) => getHeaderValue(request.headers, "stripe-signature") !== undefined,
    event: (request) => getEventString(extractJsonField(request, "type")),
  },
  {
    provider: "square",
    via: "header",
    matchedOn: "x-square-hmacsha256-signature",
    matches: (request) =>
      getHeaderValue(request.headers, "x-square-hmacsha256-signature") !== undefined,
    event: (request) => getEventString(extractJsonField(request, "type")),
  },
  {
    provider: "hubspot",
    via: "header",
    matchedOn: "x-hubspot-signature-v3",
    matches: (request) => getHeaderValue(request.headers, "x-hubspot-signature-v3") !== undefined,
    event: (request) => getEventString(extractJsonField(request, "0.subscriptionType")),
  },
  {
    // Mailgun has no signature header — the signature fields live in the body.
    // Detection is body-based on the presence of both signature.token and
    // signature.timestamp. extractJsonField never throws on non-JSON bodies.
    provider: "mailgun",
    via: "body",
    matchedOn: "signature.token",
    matches: (request) =>
      extractJsonField(request, "signature.token") !== undefined &&
      extractJsonField(request, "signature.timestamp") !== undefined,
    event: (request) => getEventString(extractJsonField(request, "event-data.event")),
  },
  {
    provider: "calendly",
    via: "header",
    matchedOn: "calendly-webhook-signature",
    matches: (request) =>
      getHeaderValue(request.headers, "calendly-webhook-signature") !== undefined,
    event: (request) => getEventString(extractJsonField(request, "event")),
  },
  {
    provider: "mux",
    via: "header",
    matchedOn: "mux-signature",
    matches: (request) => getHeaderValue(request.headers, "mux-signature") !== undefined,
    event: (request) => getEventString(extractJsonField(request, "type")),
  },
  {
    provider: "sentry",
    via: "header",
    matchedOn: "sentry-hook-signature",
    matches: (request) => getHeaderValue(request.headers, "sentry-hook-signature") !== undefined,
    // The `sentry-hook-resource` header carries only the resource (e.g. `issue`);
    // the action (`created`/`resolved`) lives in the body. Combine them into the
    // full event (`issue.created`) when the action is present, else fall back to
    // the bare resource.
    event: (request) => {
      const resource = getHeaderValue(request.headers, "sentry-hook-resource");
      const action = extractJsonField<string>(request, "action");
      if (resource && typeof action === "string" && action.length > 0) {
        return getEventString(`${resource}.${action}`);
      }
      return getEventString(resource);
    },
  },
  {
    // Meta (WhatsApp/Messenger/Instagram) reuses GitHub's `x-hub-signature-256`
    // header, so it must be detected by body shape BEFORE GitHub's signature
    // fallback or every Meta webhook would mis-detect as GitHub.
    provider: "meta",
    via: "body",
    matchedOn: "body.object",
    matches: (request) => {
      const body = getJsonObject(request);
      const object = getEventString(body?.object);
      return (
        object !== null &&
        Array.isArray(body?.entry) &&
        ["whatsapp_business_account", "page", "instagram", "user", "permissions"].includes(object)
      );
    },
    event: (request) => getEventString(getJsonObject(request)?.object),
  },
  {
    provider: "github",
    via: "header",
    matchedOn: "x-github-event",
    matches: (request) =>
      getHeaderValue(request.headers, "x-github-event") !== undefined ||
      getHeaderValue(request.headers, "x-hub-signature-256") !== undefined,
    event: (request) => getEventString(getHeaderValue(request.headers, "x-github-event")),
  },
  {
    provider: "shopify",
    via: "header",
    matchedOn: "x-shopify-hmac-sha256",
    matches: (request) =>
      getHeaderValue(request.headers, "x-shopify-hmac-sha256") !== undefined ||
      getHeaderValue(request.headers, "x-shopify-topic") !== undefined,
    event: (request) => getEventString(getHeaderValue(request.headers, "x-shopify-topic")),
  },
  {
    provider: "slack",
    via: "header",
    matchedOn: "x-slack-signature",
    matches: (request) => getHeaderValue(request.headers, "x-slack-signature") !== undefined,
    event: (request) =>
      getEventString(extractJsonField(request, "type")) ?? getFormFieldValue(request, "command"),
  },
  {
    provider: "twilio",
    via: "header",
    matchedOn: "x-twilio-signature",
    matches: (request) => getHeaderValue(request.headers, "x-twilio-signature") !== undefined,
    event: () => null,
  },
  {
    provider: "paddle",
    via: "header",
    matchedOn: "paddle-signature",
    matches: (request) => getHeaderValue(request.headers, "paddle-signature") !== undefined,
    event: (request) => getEventString(extractJsonField(request, "event_type")),
  },
  {
    provider: "linear",
    via: "header",
    matchedOn: "linear-signature",
    matches: (request) => getHeaderValue(request.headers, "linear-signature") !== undefined,
    event: (request) => extractLinearEvent(request),
  },
  {
    provider: "sendgrid",
    via: "body",
    matchedOn: "body[].sg_event_id",
    matches: (request) => getJsonArrayFirstObject(request)?.sg_event_id !== undefined,
    event: (request) => getEventString(getJsonArrayFirstObject(request)?.event),
  },
  {
    provider: "clerk",
    via: "header",
    matchedOn: "svix-id",
    matches: (request) => getHeaderValue(request.headers, "svix-id") !== undefined,
    event: (request) => getEventString(extractJsonField(request, "type")),
  },
  {
    provider: "discord",
    via: "header",
    matchedOn: "x-signature-ed25519",
    matches: (request) =>
      getHeaderValue(request.headers, "x-signature-ed25519") !== undefined &&
      getHeaderValue(request.headers, "x-signature-timestamp") !== undefined,
    event: (request) => extractDiscordEvent(request),
  },
  {
    provider: "vercel",
    via: "header",
    matchedOn: "x-vercel-signature",
    matches: (request) => getHeaderValue(request.headers, "x-vercel-signature") !== undefined,
    event: (request) => getEventString(extractJsonField(request, "type")),
  },
  {
    provider: "gitlab",
    via: "header",
    matchedOn: "x-gitlab-event",
    matches: (request) =>
      getHeaderValue(request.headers, "x-gitlab-event") !== undefined ||
      getHeaderValue(request.headers, "x-gitlab-token") !== undefined,
    event: (request) =>
      normalizeGitLabEvent(getHeaderValue(request.headers, "x-gitlab-event") ?? undefined),
  },
  {
    provider: "typeform",
    via: "header",
    matchedOn: "typeform-signature",
    matches: (request) => getHeaderValue(request.headers, "typeform-signature") !== undefined,
    event: (request) => getEventString(extractJsonField(request, "event_type")),
  },
  {
    provider: "standard-webhooks",
    via: "header",
    matchedOn: "webhook-signature",
    matches: (request) =>
      getHeaderValue(request.headers, "webhook-id") !== undefined &&
      getHeaderValue(request.headers, "webhook-timestamp") !== undefined &&
      getHeaderValue(request.headers, "webhook-signature") !== undefined,
    event: (request) => getEventString(extractJsonField(request, "type")),
  },
  {
    provider: "lemonsqueezy",
    via: "body",
    matchedOn: "body.meta.event_name",
    matches: (request) => extractJsonField(request, "meta.event_name") !== undefined,
    event: (request) => getEventString(extractJsonField(request, "meta.event_name")),
  },
  {
    provider: "coinbase-commerce",
    via: "header",
    matchedOn: "x-cc-webhook-signature",
    matches: (request) => getHeaderValue(request.headers, "x-cc-webhook-signature") !== undefined,
    event: (request) => getEventString(extractJsonField(request, "event.type")),
  },
  {
    provider: "razorpay",
    via: "header",
    matchedOn: "x-razorpay-signature",
    matches: (request) => getHeaderValue(request.headers, "x-razorpay-signature") !== undefined,
    event: (request) => getEventString(extractJsonField(request, "event")),
  },
  {
    provider: "cal",
    via: "header",
    matchedOn: "x-cal-signature-256",
    matches: (request) => getHeaderValue(request.headers, "x-cal-signature-256") !== undefined,
    event: (request) => getEventString(extractJsonField(request, "triggerEvent")),
  },
  {
    // Bitbucket reuses the legacy `x-hub-signature` header (with the GitHub-style
    // `sha256=` scheme), so it MUST be ordered BEFORE Intercom (which uses the
    // same header with `sha1=`). Bitbucket carries a unique `x-event-key` header,
    // so we detect on that to avoid the collision entirely.
    provider: "bitbucket",
    via: "header",
    matchedOn: "x-event-key",
    matches: (request) => getHeaderValue(request.headers, "x-event-key") !== undefined,
    event: (request) => getEventString(getHeaderValue(request.headers, "x-event-key")),
  },
  {
    // Intercom reuses the legacy `x-hub-signature` (sha1=) header. It MUST be
    // ordered after GitHub (which sends the same header alongside
    // x-hub-signature-256 + x-github-event) and after Bitbucket (sha256= +
    // x-event-key), and is disambiguated from Bitbucket by requiring the sha1=
    // prefix or the Intercom body.
    provider: "intercom",
    via: "header",
    matchedOn: "x-hub-signature",
    matches: (request) => {
      // Require the Intercom header. Without it we'd shadow other providers
      // (e.g. a Telegram body that happens to carry type=notification_event).
      // This also keeps SDK detection aligned with the header-only receiver.
      const sig = getHeaderValue(request.headers, "x-hub-signature");
      if (sig === undefined) {
        return false;
      }
      // sha1= is the Intercom scheme; the body check disambiguates from
      // Bitbucket (sha256=), which carries the same header.
      return (
        sig.trim().toLowerCase().startsWith("sha1=") ||
        extractJsonField(request, "type") === "notification_event"
      );
    },
    event: (request) => getEventString(extractJsonField(request, "topic")),
  },
  {
    provider: "telegram",
    via: "header",
    matchedOn: "x-telegram-bot-api-secret-token",
    matches: (request) =>
      getHeaderValue(request.headers, "x-telegram-bot-api-secret-token") !== undefined,
    event: () => null,
  },
] as const;

function isDetectedProvider(request: WebhookLike, provider: TemplateProvider): boolean {
  return detectWebhookProvider(request) === provider;
}

/**
 * Best-effort provider detection from request headers and body.
 * Returns only the provider name, or null when the request doesn't match a known provider.
 */
export function detectWebhookProvider(request: WebhookLike): TemplateProvider | null {
  return detectWebhookInfo(request)?.provider ?? null;
}

/**
 * Best-effort provider + event detection from request headers and body.
 * Uses an ordered detector list so more specific providers win over generic matches.
 */
export function detectWebhookInfo(request: WebhookLike): DetectedWebhookInfo | null {
  for (const detector of DETECTORS) {
    if (detector.matches(request)) {
      return {
        provider: detector.provider,
        event: detector.event(request),
        via: detector.via,
        matchedOn: detector.matchedOn,
      };
    }
  }

  return null;
}
