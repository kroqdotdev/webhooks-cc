import type { ParsedBody, ParsedFormBody, Request } from "./types";

function getHeaderValue(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function getContentType(request: Request): string | undefined {
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
export function parseJsonBody(request: Request): unknown | undefined {
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
  return Object.keys(request.headers).some((k) => k.toLowerCase() === "stripe-signature");
}

/**
 * Check if a request looks like a GitHub webhook.
 * Matches on the `x-github-event` header being present.
 */
export function isGitHubWebhook(request: Request): boolean {
  return Object.keys(request.headers).some((k) => k.toLowerCase() === "x-github-event");
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
export function parseFormBody(request: Request): ParsedFormBody | undefined {
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
export function parseBody(request: Request): ParsedBody {
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
export function extractJsonField<T>(request: Request, path: string): T | undefined {
  const body = parseJsonBody(request);
  if (body === undefined) {
    return undefined;
  }
  return getJsonPathValue(body, path) as T | undefined;
}

/** Check if a request looks like a Shopify webhook. */
export function isShopifyWebhook(request: Request): boolean {
  return Object.keys(request.headers).some((k) => k.toLowerCase() === "x-shopify-hmac-sha256");
}

/** Check if a request looks like a Slack webhook. */
export function isSlackWebhook(request: Request): boolean {
  return Object.keys(request.headers).some((k) => k.toLowerCase() === "x-slack-signature");
}

/** Check if a request looks like a Twilio webhook. */
export function isTwilioWebhook(request: Request): boolean {
  return Object.keys(request.headers).some((k) => k.toLowerCase() === "x-twilio-signature");
}

/** Check if a request looks like a Paddle webhook. */
export function isPaddleWebhook(request: Request): boolean {
  return Object.keys(request.headers).some((k) => k.toLowerCase() === "paddle-signature");
}

/** Check if a request looks like a Linear webhook. */
export function isLinearWebhook(request: Request): boolean {
  return Object.keys(request.headers).some((k) => k.toLowerCase() === "linear-signature");
}

/** Check if a request looks like a Discord interaction webhook. */
export function isDiscordWebhook(request: Request): boolean {
  const keys = Object.keys(request.headers).map((k) => k.toLowerCase());
  return keys.includes("x-signature-ed25519") && keys.includes("x-signature-timestamp");
}

/**
 * Check if a request looks like a Standard Webhooks request.
 * Matches on the presence of all three Standard Webhooks headers:
 * webhook-id, webhook-timestamp, and webhook-signature.
 */
export function isStandardWebhook(request: Request): boolean {
  const keys = Object.keys(request.headers).map((k) => k.toLowerCase());
  return (
    keys.includes("webhook-id") &&
    keys.includes("webhook-timestamp") &&
    keys.includes("webhook-signature")
  );
}
