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

  if (options.provider === "discord") {
    valid = await verifyDiscordSignature(request.body, request.headers, options.publicKey);
  }

  if (options.provider === "standard-webhooks") {
    valid = await verifyStandardWebhookSignature(request.body, request.headers, options.secret);
  }

  return { valid };
}
