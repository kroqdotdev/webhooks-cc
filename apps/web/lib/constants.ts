import { publicEnv } from "./env";

/**
 * Webhook receiver base URL.
 * Validated at startup via centralized env validation.
 */
export const WEBHOOK_BASE_URL = publicEnv().NEXT_PUBLIC_WEBHOOK_URL;

/** Valid slug format: alphanumeric with hyphens/underscores, 1-50 chars */
const SLUG_REGEX = /^[a-zA-Z0-9_-]{1,50}$/;

/**
 * Constructs the full webhook URL for a given endpoint slug.
 * Validates the slug to prevent URL injection attacks.
 * @throws Error if slug contains invalid characters
 */
export function getWebhookUrl(slug: string): string {
  if (!SLUG_REGEX.test(slug)) {
    throw new Error(
      "Invalid slug: must contain only alphanumeric characters, hyphens, and underscores (1-50 chars)"
    );
  }
  return `${WEBHOOK_BASE_URL}/w/${slug}`;
}

/**
 * Headers to omit when generating curl commands.
 * - host: curl sets this based on the URL
 * - content-length: curl calculates this from the body
 * - connection: curl manages connection lifecycle
 */
export const SKIP_HEADERS_FOR_CURL: readonly string[] = ["host", "content-length", "connection"];

/**
 * Proxy/CDN headers added by infrastructure (Cloudflare, Caddy) — not part
 * of the original sender's request.
 */
const PROXY_HEADERS: readonly string[] = [
  "cdn-loop",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "true-client-ip",
];

/**
 * Headers to omit when replaying requests.
 * Extends SKIP_HEADERS_FOR_CURL with:
 * - accept-encoding: let the HTTP client handle compression negotiation
 * - proxy/CDN headers: not part of the original request
 */
export const SKIP_HEADERS_FOR_REPLAY: readonly string[] = [
  ...SKIP_HEADERS_FOR_CURL,
  "accept-encoding",
  ...PROXY_HEADERS,
];
