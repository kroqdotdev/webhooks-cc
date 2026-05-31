import type {
  Request as CapturedRequest,
  SearchResult,
  SignatureVerificationResult,
  VerifySignatureOptions,
} from "./types";
import {
  buildTwilioSignaturePayload,
  decodeStandardWebhookSecret,
  hmacSign,
  hmacSignRaw,
  toBase64,
  toHex,
} from "./templates";

type VerifyableRequest =
  | Pick<CapturedRequest, "body" | "headers">
  | Pick<SearchResult, "body" | "headers">;

function requireSecret(secret: string, functionName: string): void {
  if (!secret || typeof secret !== "string") {
    throw new Error(`${functionName} requires a non-empty secret`);
  }
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function normalizeBody(body?: string): string {
  return body ?? "";
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (!/^[a-f0-9]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error("Expected a hex-encoded value");
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < left.length; i++) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

function parseStripeHeader(
  signatureHeader: string | null | undefined
): { timestamp: string; signatures: string[] } | null {
  if (!signatureHeader) {
    return null;
  }

  let timestamp: string | undefined;
  const signatures: string[] = [];

  for (const part of signatureHeader.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!value) {
      continue;
    }

    if (key === "t") {
      timestamp = value;
      continue;
    }
    if (key === "v1") {
      signatures.push(value.toLowerCase());
    }
  }

  if (!timestamp || signatures.length === 0) {
    return null;
  }

  return { timestamp, signatures };
}

function parseStandardSignatures(signatureHeader: string | null | undefined): string[] {
  if (!signatureHeader) {
    return [];
  }

  const matches = Array.from(
    signatureHeader.matchAll(/v1,([A-Za-z0-9+/=]+)/g),
    (match) => match[1]
  );
  if (matches.length > 0) {
    return matches;
  }

  const [version, signature] = signatureHeader.split(",", 2);
  if (version?.trim() === "v1" && signature?.trim()) {
    return [signature.trim()];
  }

  return [];
}

function parsePaddleSignature(
  signatureHeader: string | null | undefined
): { timestamp: string; signatures: string[] } | null {
  if (!signatureHeader) {
    return null;
  }

  let timestamp: string | undefined;
  const signatures: string[] = [];

  for (const part of signatureHeader.split(/[;,]/)) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim().toLowerCase();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!value) {
      continue;
    }

    if (key === "ts") {
      timestamp = value;
      continue;
    }
    if (key === "h1") {
      signatures.push(value.toLowerCase());
    }
  }

  if (!timestamp || signatures.length === 0) {
    return null;
  }

  return { timestamp, signatures };
}

function toTwilioParams(body: string | Record<string, string> | undefined): [string, string][] {
  if (body === undefined) {
    return [];
  }

  if (typeof body === "string") {
    return Array.from(new URLSearchParams(body).entries());
  }

  return Object.entries(body).map(([key, value]) => [key, String(value)]);
}

/**
 * Verify a Stripe webhook signature header against the raw request body.
 */
export async function verifyStripeSignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifyStripeSignature");
  const parsed = parseStripeHeader(signatureHeader);
  if (!parsed) {
    return false;
  }

  const expected = toHex(
    await hmacSign("SHA-256", secret, `${parsed.timestamp}.${normalizeBody(body)}`)
  ).toLowerCase();
  return parsed.signatures.some((signature) => timingSafeEqual(signature, expected));
}

/**
 * Verify a GitHub webhook signature header against the raw request body.
 */
export async function verifyGitHubSignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifyGitHubSignature");
  if (!signatureHeader) {
    return false;
  }

  const match = signatureHeader.trim().match(/^sha256=(.+)$/i);
  if (!match) {
    return false;
  }

  const expected = toHex(await hmacSign("SHA-256", secret, normalizeBody(body))).toLowerCase();
  return timingSafeEqual(match[1].toLowerCase(), expected);
}

/**
 * Verify a Shopify webhook signature header against the raw request body.
 */
export async function verifyShopifySignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifyShopifySignature");
  if (!signatureHeader) {
    return false;
  }

  const expected = toBase64(await hmacSign("SHA-256", secret, normalizeBody(body)));
  return timingSafeEqual(signatureHeader.trim(), expected);
}

/**
 * Verify a Twilio webhook signature against the signed URL and form body.
 */
export async function verifyTwilioSignature(
  url: string,
  body: string | Record<string, string> | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifyTwilioSignature");
  if (!url) {
    throw new Error("verifyTwilioSignature requires the signed URL");
  }
  if (!signatureHeader) {
    return false;
  }

  const expected = toBase64(
    await hmacSign("SHA-1", secret, buildTwilioSignaturePayload(url, toTwilioParams(body)))
  );
  return timingSafeEqual(signatureHeader.trim(), expected);
}

/**
 * Verify a Slack webhook signature from x-slack-signature and x-slack-request-timestamp headers.
 */
export async function verifySlackSignature(
  body: string | undefined,
  headers: Record<string, string>,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifySlackSignature");
  const signatureHeader = getHeader(headers, "x-slack-signature");
  const timestamp = getHeader(headers, "x-slack-request-timestamp");
  if (!signatureHeader || !timestamp) {
    return false;
  }

  const match = signatureHeader.trim().match(/^v0=(.+)$/i);
  if (!match) {
    return false;
  }

  const expected = toHex(
    await hmacSign("SHA-256", secret, `v0:${timestamp}:${normalizeBody(body)}`)
  ).toLowerCase();
  return timingSafeEqual(match[1].toLowerCase(), expected);
}

/**
 * Verify a Paddle webhook signature from the paddle-signature header.
 */
export async function verifyPaddleSignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifyPaddleSignature");
  const parsed = parsePaddleSignature(signatureHeader);
  if (!parsed) {
    return false;
  }

  const expected = toHex(
    await hmacSign("SHA-256", secret, `${parsed.timestamp}:${normalizeBody(body)}`)
  ).toLowerCase();
  return parsed.signatures.some((signature) => timingSafeEqual(signature, expected));
}

/**
 * Verify a Linear webhook signature against the raw request body.
 */
export async function verifyLinearSignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifyLinearSignature");
  if (!signatureHeader) {
    return false;
  }

  const match = signatureHeader.trim().match(/^(?:sha256=)?(.+)$/i);
  if (!match) {
    return false;
  }

  const expected = toHex(await hmacSign("SHA-256", secret, normalizeBody(body))).toLowerCase();
  return timingSafeEqual(match[1].toLowerCase(), expected);
}

/**
 * Shared verifier for providers that send a raw hex HMAC-SHA256 of the body,
 * optionally with a `prefix=` form (e.g. `sha256=...`). Used by Lemon Squeezy,
 * Coinbase Commerce, Razorpay, and Cal.com.
 */
async function hmacSha256HexMatches(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string,
  functionName: string
): Promise<boolean> {
  requireSecret(secret, functionName);
  if (!signatureHeader) return false;
  const received = signatureHeader.trim();
  const hex = received.includes("=") ? received.slice(received.indexOf("=") + 1) : received;
  if (!hex) return false;
  const expected = toHex(await hmacSign("SHA-256", secret, normalizeBody(body))).toLowerCase();
  return timingSafeEqual(hex.toLowerCase(), expected);
}

/**
 * Verify a Meta (WhatsApp/Messenger/Instagram) webhook — identical scheme to GitHub
 * (`sha256=` hex HMAC-SHA256 over the raw body, keyed by the Meta app secret).
 */
export function verifyMetaSignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  appSecret: string
): Promise<boolean> {
  return verifyGitHubSignature(body, signatureHeader, appSecret);
}

/**
 * Verify a Lemon Squeezy webhook signature (raw hex HMAC-SHA256 over the body,
 * sent in the `X-Signature` header).
 */
export function verifyLemonSqueezySignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  return hmacSha256HexMatches(body, signatureHeader, secret, "verifyLemonSqueezySignature");
}

/**
 * Verify a Coinbase Commerce webhook signature (raw hex HMAC-SHA256 over the body,
 * sent in the `X-CC-Webhook-Signature` header).
 */
export function verifyCoinbaseCommerceSignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  return hmacSha256HexMatches(body, signatureHeader, secret, "verifyCoinbaseCommerceSignature");
}

/**
 * Verify a Razorpay webhook signature (raw hex HMAC-SHA256 over the body,
 * sent in the `X-Razorpay-Signature` header).
 */
export function verifyRazorpaySignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  return hmacSha256HexMatches(body, signatureHeader, secret, "verifyRazorpaySignature");
}

/**
 * Verify a Cal.com webhook signature (raw hex HMAC-SHA256 over the body,
 * sent in the `X-Cal-Signature-256` header).
 */
export function verifyCalSignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  return hmacSha256HexMatches(body, signatureHeader, secret, "verifyCalSignature");
}

/**
 * Verify an Intercom webhook signature (HMAC-**SHA1** hex with a `sha1=` prefix,
 * sent in the `X-Hub-Signature` header, keyed by the Intercom app secret).
 */
export async function verifyIntercomSignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifyIntercomSignature");
  if (!signatureHeader) {
    return false;
  }

  const match = signatureHeader.trim().match(/^sha1=(.+)$/i);
  if (!match) {
    return false;
  }

  const expected = toHex(await hmacSign("SHA-1", secret, normalizeBody(body))).toLowerCase();
  return timingSafeEqual(match[1].toLowerCase(), expected);
}

/**
 * Verify a Telegram webhook secret token against the
 * `X-Telegram-Bot-Api-Secret-Token` header. Telegram sends the raw secret in
 * the header — no HMAC involved (same scheme as GitLab).
 */
export async function verifyTelegramSignature(
  _body: string | undefined,
  tokenHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifyTelegramSignature");
  if (!tokenHeader) {
    return false;
  }

  return timingSafeEqual(tokenHeader, secret);
}

/**
 * Verify a Square webhook signature. Square computes
 * `base64(HMAC-SHA256(signatureKey, notificationUrl + rawBody))` and sends it in
 * the `x-square-hmacsha256-signature` header. The signature is bound to the exact
 * notification URL Square delivered to, so the caller must supply it.
 */
export async function verifySquareSignature(
  url: string,
  body: string | undefined,
  signatureHeader: string | null | undefined,
  signatureKey: string
): Promise<boolean> {
  requireSecret(signatureKey, "verifySquareSignature");
  if (!url) {
    throw new Error("verifySquareSignature requires the notification URL");
  }
  if (!signatureHeader) {
    return false;
  }

  const expected = toBase64(
    await hmacSign("SHA-256", signatureKey, `${url}${normalizeBody(body)}`)
  );
  return timingSafeEqual(signatureHeader.trim(), expected);
}

/**
 * Verify a HubSpot v3 webhook signature. HubSpot computes
 * `base64(HMAC-SHA256(clientSecret, requestMethod + requestUri + rawBody + timestamp))`
 * and sends it in `x-hubspot-signature-v3`, alongside the request timestamp (in
 * milliseconds) in `x-hubspot-request-timestamp`. Because the signature is bound
 * to the exact method and URI, the caller must supply both. Signatures with a
 * timestamp older than `maxAgeMs` (5 minutes by default) are rejected to defeat
 * replay attacks.
 */
export async function verifyHubSpotSignature(
  method: string,
  url: string,
  body: string | undefined,
  signatureHeader: string | null | undefined,
  timestamp: string | null | undefined,
  secret: string,
  maxAgeMs = 5 * 60 * 1000
): Promise<boolean> {
  requireSecret(secret, "verifyHubSpotSignature");
  if (!signatureHeader || !timestamp) {
    return false;
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > maxAgeMs) {
    return false;
  }
  const base = `${method.toUpperCase()}${url}${normalizeBody(body)}${timestamp}`;
  const expected = toBase64(await hmacSign("SHA-256", secret, base));
  return timingSafeEqual(signatureHeader.trim(), expected);
}

/**
 * Verify a Mailgun webhook signature. Mailgun does not send a signature header —
 * the `timestamp`, `token`, and `signature` fields live inside the JSON body
 * under `signature`. The signature is the hex HMAC-SHA256 of `timestamp + token`
 * keyed by the HTTP webhook signing key. Malformed or non-JSON bodies, or bodies
 * missing the signature fields, return `false` (this function never throws on
 * bad input).
 */
export async function verifyMailgunSignature(
  body: string | undefined,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifyMailgunSignature");
  if (!body) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") {
    return false;
  }
  const sig = (parsed as { signature?: unknown }).signature;
  if (!sig || typeof sig !== "object") {
    return false;
  }
  const { timestamp, token, signature } = sig as {
    timestamp?: unknown;
    token?: unknown;
    signature?: unknown;
  };
  if (
    typeof timestamp !== "string" ||
    typeof token !== "string" ||
    typeof signature !== "string" ||
    !timestamp ||
    !token ||
    !signature
  ) {
    return false;
  }
  const expected = toHex(await hmacSign("SHA-256", secret, `${timestamp}${token}`)).toLowerCase();
  return timingSafeEqual(signature.toLowerCase(), expected);
}

/**
 * Verify a Calendly webhook signature. Calendly uses the Stripe-style header
 * format `t=<timestamp>,v1=<signature>` in `calendly-webhook-signature`, where
 * the signature is the hex HMAC-SHA256 of `${timestamp}.${body}` keyed by the
 * webhook signing key. Reuses the shared Stripe header parser.
 */
export async function verifyCalendlySignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifyCalendlySignature");
  const parsed = parseStripeHeader(signatureHeader);
  if (!parsed) {
    return false;
  }
  const expected = toHex(
    await hmacSign("SHA-256", secret, `${parsed.timestamp}.${normalizeBody(body)}`)
  ).toLowerCase();
  return parsed.signatures.some((signature) => timingSafeEqual(signature, expected));
}

/**
 * Verify a Mux webhook signature. Mux uses the same Stripe-style header format
 * `t=<timestamp>,v1=<signature>` as Calendly, this time in `mux-signature`,
 * where the signature is the hex HMAC-SHA256 of `${timestamp}.${body}` keyed by
 * the webhook signing secret. Reuses the shared Stripe header parser.
 */
export async function verifyMuxSignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifyMuxSignature");
  const parsed = parseStripeHeader(signatureHeader);
  if (!parsed) {
    return false;
  }
  const expected = toHex(
    await hmacSign("SHA-256", secret, `${parsed.timestamp}.${normalizeBody(body)}`)
  ).toLowerCase();
  return parsed.signatures.some((signature) => timingSafeEqual(signature, expected));
}

/**
 * Verify a Sentry webhook signature (raw hex HMAC-SHA256 over the body, sent in
 * the `sentry-hook-signature` header). Reuses the shared hex HMAC helper.
 */
export function verifySentrySignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  return hmacSha256HexMatches(body, signatureHeader, secret, "verifySentrySignature");
}

/**
 * Verify a Vercel webhook signature against the raw request body.
 * Vercel signs with HMAC-SHA1 and sends the hex-encoded signature in x-vercel-signature.
 */
export async function verifyVercelSignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifyVercelSignature");
  if (!signatureHeader) {
    return false;
  }

  const expected = toHex(await hmacSign("SHA-1", secret, normalizeBody(body))).toLowerCase();
  return timingSafeEqual(signatureHeader.trim().toLowerCase(), expected);
}

/**
 * Verify a GitLab webhook token against the x-gitlab-token header.
 * GitLab sends the raw secret in the header — no HMAC involved.
 */
export async function verifyGitLabSignature(
  _body: string | undefined,
  tokenHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifyGitLabSignature");
  if (!tokenHeader) {
    return false;
  }

  return timingSafeEqual(tokenHeader, secret);
}

/**
 * Verify a Typeform webhook signature header against the raw request body.
 * Typeform signs the exact JSON body with HMAC-SHA256 and sends sha256={base64}.
 */
export async function verifyTypeformSignature(
  body: string | undefined,
  signatureHeader: string | null | undefined,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifyTypeformSignature");
  if (!signatureHeader) {
    return false;
  }

  const received = signatureHeader.trim();
  const signature = received.startsWith("sha256=") ? received.slice("sha256=".length) : received;
  if (!signature) {
    return false;
  }

  const expected = toBase64(await hmacSign("SHA-256", secret, normalizeBody(body)));
  return timingSafeEqual(signature, expected);
}

/**
 * Verify a Clerk webhook signature using Standard Webhooks (Svix) signing.
 * Delegates to verifyStandardWebhookSignature.
 */
export async function verifyClerkSignature(
  body: string | undefined,
  headers: Record<string, string>,
  secret: string
): Promise<boolean> {
  // Clerk sends both svix-* and webhook-* headers via Svix. Normalize
  // svix-* to webhook-* so verifyStandardWebhookSignature can find them
  // even if only the svix-* variants are present.
  const normalized = { ...headers };
  const svixId = getHeader(headers, "svix-id");
  const svixTs = getHeader(headers, "svix-timestamp");
  const svixSig = getHeader(headers, "svix-signature");
  if (svixId && !getHeader(headers, "webhook-id")) normalized["webhook-id"] = svixId;
  if (svixTs && !getHeader(headers, "webhook-timestamp")) normalized["webhook-timestamp"] = svixTs;
  if (svixSig && !getHeader(headers, "webhook-signature"))
    normalized["webhook-signature"] = svixSig;
  return verifyStandardWebhookSignature(body, normalized, secret);
}

/**
 * Verify a Discord interaction signature using the application's Ed25519 public key.
 */
export async function verifyDiscordSignature(
  body: string | undefined,
  headers: Record<string, string>,
  publicKey: string
): Promise<boolean> {
  if (!publicKey || typeof publicKey !== "string") {
    throw new Error("verifyDiscordSignature requires a non-empty public key");
  }

  const signatureHeader = getHeader(headers, "x-signature-ed25519");
  const timestamp = getHeader(headers, "x-signature-timestamp");
  if (!signatureHeader || !timestamp) {
    return false;
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error("crypto.subtle is required for Discord signature verification");
  }

  try {
    const publicKeyBytes = hexToBytes(publicKey);
    const signatureBytes = hexToBytes(signatureHeader);
    const publicKeyData = new Uint8Array(publicKeyBytes.byteLength);
    publicKeyData.set(publicKeyBytes);
    const signatureData = new Uint8Array(signatureBytes.byteLength);
    signatureData.set(signatureBytes);
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      publicKeyData,
      { name: "Ed25519" },
      false,
      ["verify"]
    );

    return await globalThis.crypto.subtle.verify(
      "Ed25519",
      key,
      signatureData,
      new TextEncoder().encode(`${timestamp}${normalizeBody(body)}`)
    );
  } catch {
    return false;
  }
}

/**
 * Verify a Standard Webhooks signature from webhook-id/timestamp/signature headers.
 */
export async function verifyStandardWebhookSignature(
  body: string | undefined,
  headers: Record<string, string>,
  secret: string
): Promise<boolean> {
  requireSecret(secret, "verifyStandardWebhookSignature");
  const messageId = getHeader(headers, "webhook-id");
  const timestamp = getHeader(headers, "webhook-timestamp");
  const signatureHeader = getHeader(headers, "webhook-signature");

  if (!messageId || !timestamp || !signatureHeader) {
    return false;
  }

  const expected = toBase64(
    await hmacSignRaw(
      "SHA-256",
      decodeStandardWebhookSecret(secret),
      `${messageId}.${timestamp}.${normalizeBody(body)}`
    )
  );
  return parseStandardSignatures(signatureHeader).some((signature) =>
    timingSafeEqual(signature, expected)
  );
}

/**
 * Verify a captured request using the provider-specific signature scheme.
 */
export async function verifySignature(
  request: VerifyableRequest,
  options: VerifySignatureOptions
): Promise<SignatureVerificationResult> {
  let valid = false;

  if (options.provider === "stripe") {
    valid = await verifyStripeSignature(
      request.body,
      getHeader(request.headers, "stripe-signature"),
      options.secret
    );
  }

  if (options.provider === "github") {
    valid = await verifyGitHubSignature(
      request.body,
      getHeader(request.headers, "x-hub-signature-256"),
      options.secret
    );
  }

  if (options.provider === "shopify") {
    valid = await verifyShopifySignature(
      request.body,
      getHeader(request.headers, "x-shopify-hmac-sha256"),
      options.secret
    );
  }

  if (options.provider === "twilio") {
    if (!options.url) {
      throw new Error('verifySignature for provider "twilio" requires options.url');
    }
    valid = await verifyTwilioSignature(
      options.url,
      request.body,
      getHeader(request.headers, "x-twilio-signature"),
      options.secret
    );
  }

  if (options.provider === "slack") {
    valid = await verifySlackSignature(request.body, request.headers, options.secret);
  }

  if (options.provider === "paddle") {
    valid = await verifyPaddleSignature(
      request.body,
      getHeader(request.headers, "paddle-signature"),
      options.secret
    );
  }

  if (options.provider === "linear") {
    valid = await verifyLinearSignature(
      request.body,
      getHeader(request.headers, "linear-signature"),
      options.secret
    );
  }

  if (options.provider === "clerk") {
    valid = await verifyClerkSignature(request.body, request.headers, options.secret);
  }

  if (options.provider === "vercel") {
    valid = await verifyVercelSignature(
      request.body,
      getHeader(request.headers, "x-vercel-signature"),
      options.secret
    );
  }

  if (options.provider === "gitlab") {
    valid = await verifyGitLabSignature(
      request.body,
      getHeader(request.headers, "x-gitlab-token"),
      options.secret
    );
  }

  if (options.provider === "typeform") {
    valid = await verifyTypeformSignature(
      request.body,
      getHeader(request.headers, "typeform-signature"),
      options.secret
    );
  }

  if (options.provider === "sendgrid") {
    throw new Error(
      "SendGrid does not use signature verification. SendGrid webhooks are verified via IP allowlisting."
    );
  }

  if (options.provider === "discord") {
    valid = await verifyDiscordSignature(request.body, request.headers, options.publicKey);
  }

  if (options.provider === "standard-webhooks") {
    valid = await verifyStandardWebhookSignature(request.body, request.headers, options.secret);
  }

  if (options.provider === "meta") {
    valid = await verifyMetaSignature(
      request.body,
      getHeader(request.headers, "x-hub-signature-256"),
      options.secret
    );
  }

  if (options.provider === "lemonsqueezy") {
    valid = await verifyLemonSqueezySignature(
      request.body,
      getHeader(request.headers, "x-signature"),
      options.secret
    );
  }

  if (options.provider === "coinbase-commerce") {
    valid = await verifyCoinbaseCommerceSignature(
      request.body,
      getHeader(request.headers, "x-cc-webhook-signature"),
      options.secret
    );
  }

  if (options.provider === "razorpay") {
    valid = await verifyRazorpaySignature(
      request.body,
      getHeader(request.headers, "x-razorpay-signature"),
      options.secret
    );
  }

  if (options.provider === "cal") {
    valid = await verifyCalSignature(
      request.body,
      getHeader(request.headers, "x-cal-signature-256"),
      options.secret
    );
  }

  if (options.provider === "intercom") {
    valid = await verifyIntercomSignature(
      request.body,
      getHeader(request.headers, "x-hub-signature"),
      options.secret
    );
  }

  if (options.provider === "telegram") {
    valid = await verifyTelegramSignature(
      request.body,
      getHeader(request.headers, "x-telegram-bot-api-secret-token"),
      options.secret
    );
  }

  if (options.provider === "square") {
    if (!options.url) {
      throw new Error('verifySignature for provider "square" requires options.url');
    }
    valid = await verifySquareSignature(
      options.url,
      request.body,
      getHeader(request.headers, "x-square-hmacsha256-signature"),
      options.secret
    );
  }

  if (options.provider === "hubspot") {
    if (!options.url) {
      throw new Error('verifySignature for provider "hubspot" requires options.url');
    }
    valid = await verifyHubSpotSignature(
      options.method ?? "POST",
      options.url,
      request.body,
      getHeader(request.headers, "x-hubspot-signature-v3"),
      getHeader(request.headers, "x-hubspot-request-timestamp"),
      options.secret
    );
  }

  if (options.provider === "mailgun") {
    valid = await verifyMailgunSignature(request.body, options.secret);
  }

  if (options.provider === "calendly") {
    valid = await verifyCalendlySignature(
      request.body,
      getHeader(request.headers, "calendly-webhook-signature"),
      options.secret
    );
  }

  if (options.provider === "mux") {
    valid = await verifyMuxSignature(
      request.body,
      getHeader(request.headers, "mux-signature"),
      options.secret
    );
  }

  if (options.provider === "sentry") {
    valid = await verifySentrySignature(
      request.body,
      getHeader(request.headers, "sentry-hook-signature"),
      options.secret
    );
  }

  return { valid };
}
