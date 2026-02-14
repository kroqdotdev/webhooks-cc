import type { Request } from "./types";

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
