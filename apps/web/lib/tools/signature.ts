import {
  TEMPLATE_METADATA,
  VERIFY_PROVIDERS,
  buildTemplateSendOptions,
  verifySignature,
  type VerifyProvider,
} from "@webhooks-cc/sdk";
import { getWebProviderInfo, getWebProviderLabel } from "@/lib/provider-catalog";

/**
 * The webhook signature checker's logic. Two things, both in the browser
 * with WebCrypto and nothing sent anywhere:
 *
 * - a plain HMAC over a payload, in the algorithm and encoding chosen;
 * - a provider's own scheme (what it signs, where the timestamp goes, how the
 *   secret is decoded), which is the SDK's: `verifySignature` checks a
 *   request and `buildTemplateSendOptions` signs one, the same functions the
 *   dashboard, the CLI and the MCP server use. Nothing provider-specific is
 *   written here, so a scheme fixed in the SDK is fixed in this tool.
 */

export type HmacAlgorithm = "SHA-256" | "SHA-1" | "SHA-384" | "SHA-512";
export const HMAC_ALGORITHMS: readonly HmacAlgorithm[] = ["SHA-256", "SHA-1", "SHA-384", "SHA-512"];

export type SignatureEncoding = "hex" | "base64" | "base64url";
export const SIGNATURE_ENCODINGS: readonly { value: SignatureEncoding; label: string }[] = [
  { value: "hex", label: "Hex" },
  { value: "base64", label: "Base64" },
  { value: "base64url", label: "Base64url" },
];

/** How the secret's text becomes key bytes. */
export type SecretEncoding = "utf8" | "hex" | "base64";
export const SECRET_ENCODINGS: readonly { value: SecretEncoding; label: string }[] = [
  { value: "utf8", label: "Text (UTF-8)" },
  { value: "hex", label: "Hex" },
  { value: "base64", label: "Base64" },
];

const NO_WEBCRYPTO =
  "This browser does not offer WebCrypto on this page (it needs https), so the signature cannot be computed here.";

function subtle(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null;
}

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) return null;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function base64ToBytes(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (clean.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  try {
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encode(bytes: Uint8Array, encoding: SignatureEncoding): string {
  if (encoding === "hex") return bytesToHex(bytes);
  const base64 = bytesToBase64(bytes);
  return encoding === "base64"
    ? base64
    : base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface HmacInput {
  secret: string;
  secretEncoding: SecretEncoding;
  /** The exact text that was signed; whitespace counts. */
  payload: string;
  algorithm: HmacAlgorithm;
  encoding: SignatureEncoding;
}

export type HmacResult = { ok: true; signature: string } | { ok: false; problem: string };

/** HMAC of the payload under the secret, encoded as asked. */
export async function computeHmac(input: HmacInput): Promise<HmacResult> {
  if (!input.secret) return { ok: false, problem: "Enter the secret the signature is made with." };

  let key: Uint8Array | null;
  if (input.secretEncoding === "hex") {
    key = hexToBytes(input.secret);
    if (!key) return { ok: false, problem: "The secret is not hex: use pairs of 0-9 and a-f." };
  } else if (input.secretEncoding === "base64") {
    key = base64ToBytes(input.secret);
    if (!key) return { ok: false, problem: "The secret is not valid Base64." };
  } else {
    key = new TextEncoder().encode(input.secret);
  }

  const crypto = subtle();
  if (!crypto) return { ok: false, problem: NO_WEBCRYPTO };

  const cryptoKey = await crypto.importKey(
    "raw",
    key.buffer as ArrayBuffer,
    { name: "HMAC", hash: input.algorithm },
    false,
    ["sign"]
  );
  const message = new TextEncoder().encode(input.payload);
  const signature = await crypto.sign("HMAC", cryptoKey, message.buffer as ArrayBuffer);
  return { ok: true, signature: encode(new Uint8Array(signature), input.encoding) };
}

/**
 * Whether a signature someone pasted is the computed one. A header often
 * carries a label before the value ("sha256=..."), hex is written in either
 * case, and Base64 with or without padding and in either alphabet.
 */
export function signaturesMatch(
  computed: string,
  given: string,
  encoding: SignatureEncoding
): boolean {
  let value = given.trim().replace(/^["']|["']$/g, "");
  value = value.replace(/^(?:sha1|sha256|sha384|sha512|v0|v1)=/i, "");
  if (!value) return false;
  if (encoding === "hex") return sameText(computed.toLowerCase(), value.toLowerCase());
  const plain = (text: string) => text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  return sameText(plain(computed), plain(value));
}

/** Equal, compared without stopping at the first difference. */
function sameText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/**
 * Schemes of the SDK this tool leaves out, each for a reason a person would
 * otherwise trip over:
 * - discord, paypal: public-key signatures, not HMAC (and PayPal's needs a
 *   certificate download the page's CSP does not allow);
 * - gitlab, telegram: a shared token compared as it is, so there is nothing
 *   to compute;
 * - mailgun, adyen: the signature sits inside the payload, not in a header;
 * - hubspot: its check refuses a request more than five minutes old, so a
 *   captured request pasted here would always read as invalid.
 */
const LEFT_OUT = [
  "discord",
  "paypal",
  "gitlab",
  "telegram",
  "mailgun",
  "adyen",
  "hubspot",
] as const satisfies readonly VerifyProvider[];

export type SignaturePresetId = Exclude<
  (typeof VERIFY_PROVIDERS)[number],
  (typeof LEFT_OUT)[number]
>;

/** Providers that sign the URL the webhook was sent to along with the body. */
const SIGNS_URL: ReadonlySet<string> = new Set(["twilio", "square"]);

export interface SignaturePreset {
  id: SignaturePresetId;
  label: string;
  /** The header the signature travels in. */
  header: string;
  /** "HMAC-SHA256", as the provider catalogue names it. */
  algorithm: string;
  secretPlaceholder: string;
  /** True when the signature also covers the URL the webhook was sent to. */
  needsUrl: boolean;
}

export const SIGNATURE_PRESETS: readonly SignaturePreset[] = VERIFY_PROVIDERS.filter(
  (provider): provider is SignaturePresetId => !(LEFT_OUT as readonly string[]).includes(provider)
)
  .map((id) => {
    const meta = TEMPLATE_METADATA[id];
    const info = getWebProviderInfo(id);
    return {
      id,
      label: getWebProviderLabel(id) ?? id,
      header: "signatureHeader" in meta ? meta.signatureHeader : "",
      algorithm: info?.algorithm ?? "HMAC",
      secretPlaceholder: info?.secretPlaceholder ?? "your webhook secret",
      needsUrl: SIGNS_URL.has(id),
    };
  })
  .sort((a, b) => a.label.localeCompare(b.label));

export function getSignaturePreset(id: string): SignaturePreset | null {
  return SIGNATURE_PRESETS.find((preset) => preset.id === id) ?? null;
}

export type ParsedHeaders =
  { ok: true; headers: Record<string, string> } | { ok: false; problem: string };

/**
 * Request headers as people paste them: one "Name: value" per line (as curl,
 * a proxy log or the webhooks.cc dashboard show them), or a JSON object.
 * A request line or status line at the top is skipped.
 */
export function parseHeaderText(text: string): ParsedHeaders {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, problem: "Paste the request's headers." };

  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(parsed)) {
          if (typeof value === "string") headers[name.toLowerCase()] = value;
          else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(", ");
          else if (typeof value === "number") headers[name.toLowerCase()] = String(value);
        }
        return { ok: true, headers };
      }
    } catch {
      // Not JSON after all: read it as lines.
    }
  }

  const headers: Record<string, string> = {};
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[<>]\s+/, "");
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      // "POST /hook HTTP/1.1" and the like.
      if (/HTTP\/\d/.test(line)) continue;
      return { ok: false, problem: `"${line.slice(0, 60)}" is not a header. Write Name: value.` };
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
      return { ok: false, problem: `"${name.slice(0, 60)}" is not a header name.` };
    }
    headers[name] = line.slice(colon + 1).trim();
  }
  if (Object.keys(headers).length === 0) {
    return { ok: false, problem: "Paste the request's headers." };
  }
  return { ok: true, headers };
}

function readUrl(url: string): { ok: true; url: string } | { ok: false; problem: string } {
  const text = url.trim();
  if (!text) {
    return {
      ok: false,
      problem: "This provider signs the URL too. Enter the full URL the webhook was sent to.",
    };
  }
  try {
    const parsed = new URL(text);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return { ok: true, url: text };
  } catch {
    // Reported below.
  }
  return { ok: false, problem: "The webhook URL should be a full URL starting with https://." };
}

export interface ProviderCheckInput {
  preset: SignaturePreset;
  secret: string;
  payload: string;
  headersText: string;
  /** The URL the webhook was sent to, for the presets that sign it. */
  url: string;
  /** The current time in ms, for tests. */
  now?: number;
}

export type ProviderCheckResult =
  | {
      ok: true;
      valid: boolean;
      /** The signature header, when the pasted headers have no signature at all. */
      missing: string | null;
      /**
       * When the signature header is there but not in the form the provider
       * sends (its parts named differently, or a bare value where it names
       * them): the form, values elided, such as "t=…,v1=…".
       */
      unreadable?: string | null;
      /** How old the request's timestamp is, in seconds, when the headers carry one. */
      ageSeconds?: number | null;
    }
  | { ok: false; problem: string };

/**
 * How old a signed timestamp may be before a provider's own libraries
 * refuse it as a possible replay: five minutes for Stripe, Slack, Svix and
 * Standard Webhooks and most others. The SDK's check deliberately enforces
 * none, so captured requests verify after the fact; this tool says so
 * instead of refusing.
 */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/** A Unix time in seconds or milliseconds, as signature headers carry them. */
const UNIX_TIME = /^\d{10}$|^\d{13}$/;

/**
 * The timestamp a request's headers carry, in seconds: a header of its own
 * (x-slack-request-timestamp, webhook-timestamp, svix-timestamp) or a part
 * of the signature header (t=, ts=). Read generically, from the header
 * names and the form of the values, so no provider's scheme is copied here.
 */
export function signedTimestamp(
  headers: Record<string, string>,
  signatureHeader: string
): number | null {
  const candidates: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.includes("timestamp")) candidates.push(value.trim());
  }
  const signature = headers[signatureHeader.toLowerCase()];
  if (signature) {
    for (const part of signature.split(/[,;\s]+/)) {
      const match = /^(?:t|ts)=(\d+)$/i.exec(part);
      if (match) candidates.push(match[1]);
    }
  }
  for (const value of candidates) {
    if (!UNIX_TIME.test(value)) continue;
    const number = Number(value);
    return value.length === 13 ? Math.floor(number / 1000) : number;
  }
  return null;
}

/** The parts of a signature header: the names before "=", and "*" for each bare value. */
function headerParts(value: string): Set<string> {
  const parts = new Set<string>();
  for (const token of value.trim().split(/[,;\s]+/)) {
    if (!token) continue;
    const named = /^([a-z][a-z0-9]{0,9})=./i.exec(token);
    parts.add(named ? named[1].toLowerCase() : "*");
  }
  return parts;
}

/** A header value with its long runs (signatures, times) elided: "t=…,v1=…". */
function headerForm(value: string): string {
  return value.replace(
    /([a-z][a-z0-9]{0,9}=)?[A-Za-z0-9+/_=.-]{8,}/gi,
    (_, name: string | undefined) => `${name ?? ""}…`
  );
}

/**
 * Whether a pasted signature header has the parts the provider's own header
 * has, judged against one the SDK signs now (buildTemplateSendOptions): the
 * form, values elided, when it does not; null when it does or cannot tell.
 */
async function unreadableHeader(
  preset: SignaturePreset,
  secret: string,
  payload: string,
  url: string | undefined,
  pasted: string
): Promise<string | null> {
  if (!preset.header) return null;
  const sent = await buildTemplateSendOptions(url ?? "https://example.com/webhook", {
    provider: preset.id,
    secret,
    body: payload,
  });
  const sample = Object.entries(sent.headers ?? {}).find(
    ([name]) => name.toLowerCase() === preset.header.toLowerCase()
  )?.[1];
  if (!sample) return null;
  const want = headerParts(sample);
  const have = headerParts(pasted);
  for (const part of want) if (!have.has(part)) return headerForm(sample);
  return null;
}

/** Checks a request's signature the way the provider's scheme defines it. */
export async function checkProviderSignature(
  input: ProviderCheckInput
): Promise<ProviderCheckResult> {
  if (!input.secret) return { ok: false, problem: "Enter the webhook's signing secret." };
  const parsed = parseHeaderText(input.headersText);
  if (!parsed.ok) return parsed;
  let url: string | undefined;
  if (input.preset.needsUrl) {
    const read = readUrl(input.url);
    if (!read.ok) return read;
    url = read.url;
  }
  if (!subtle()) return { ok: false, problem: NO_WEBCRYPTO };

  try {
    const { valid } = await verifySignature(
      { body: input.payload, headers: parsed.headers },
      { provider: input.preset.id, secret: input.secret, url }
    );
    // Named only when nothing pasted looks like a signature at all: a scheme
    // may accept more than one header name (Svix's and Standard Webhooks').
    const header = input.preset.header;
    const hasSignature = Object.keys(parsed.headers).some(
      (name) => name === header || name.includes("signature")
    );
    const missing = !valid && !hasSignature ? header : null;
    const pasted = parsed.headers[header.toLowerCase()];
    const unreadable =
      !valid && !missing && pasted
        ? await unreadableHeader(input.preset, input.secret, input.payload, url, pasted).catch(
            () => null
          )
        : null;
    const at = signedTimestamp(parsed.headers, header);
    const ageSeconds = at === null ? null : Math.floor((input.now ?? Date.now()) / 1000) - at;
    return { ok: true, valid, missing, unreadable, ageSeconds };
  } catch (error) {
    return {
      ok: false,
      problem: error instanceof Error ? error.message : "The signature could not be checked.",
    };
  }
}

export interface ProviderSignInput {
  preset: SignaturePreset;
  secret: string;
  payload: string;
  url: string;
}

export type ProviderSignResult =
  { ok: true; headers: [name: string, value: string][] } | { ok: false; problem: string };

/** Headers every request has, which say nothing about the signature. */
const NOT_SIGNATURE = /^(content-type|user-agent|x-webhooks-cc-template-.*)$/;

/**
 * The signature headers the provider would send with this payload, stamped
 * with the current time where the scheme has a timestamp. The SDK signs it;
 * the headers kept are the ones its own check cannot do without, found by
 * leaving each out in turn.
 */
export async function signProviderPayload(input: ProviderSignInput): Promise<ProviderSignResult> {
  if (!input.secret) return { ok: false, problem: "Enter the webhook's signing secret." };
  let url = "https://example.com/webhook";
  if (input.preset.needsUrl) {
    const read = readUrl(input.url);
    if (!read.ok) return read;
    url = read.url;
  }
  if (!subtle()) return { ok: false, problem: NO_WEBCRYPTO };

  try {
    const provider = input.preset.id;
    const sent = await buildTemplateSendOptions(url, {
      provider,
      secret: input.secret,
      body: input.payload,
    });
    const body = typeof sent.body === "string" ? sent.body : input.payload;
    const all = Object.entries(sent.headers ?? {}).filter(([name]) => !NOT_SIGNATURE.test(name));
    const verifies = async (headers: [string, string][]) =>
      (
        await verifySignature(
          { body, headers: Object.fromEntries(headers) },
          { provider, secret: input.secret, url }
        )
      ).valid;

    // From the last header back, so that where a scheme sends the same
    // signature under two sets of names, the first set is the one kept.
    let kept = all;
    for (const [name] of [...all].reverse()) {
      const without = kept.filter(([other]) => other !== name);
      if (await verifies(without)) kept = without;
    }
    return { ok: true, headers: kept.length > 0 ? kept : all };
  } catch (error) {
    return {
      ok: false,
      problem: error instanceof Error ? error.message : "The payload could not be signed.",
    };
  }
}

/** Header pairs as "name: value" lines, the form the check reads. */
export function headerLines(headers: readonly (readonly [string, string])[]): string {
  return headers.map(([name, value]) => `${name}: ${value}`).join("\n");
}

/** The verdict shapes the page shows; the same as a provider's answer on the sender tools. */
export interface SignatureVerdict {
  outcome: "ok" | "failed";
  title: string;
  detail: string;
  /** Something to know besides the verdict (a timestamp too old for the provider's own check). */
  warning?: string;
}

/** "62 minutes", "3 hours", "2 days". */
function age(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** Said when the request's timestamp is past the providers' tolerance, or in the future. */
function timestampWarning(preset: SignaturePreset, ageSeconds: number | null | undefined) {
  if (ageSeconds === null || ageSeconds === undefined) return undefined;
  const limit = TIMESTAMP_TOLERANCE_SECONDS / 60;
  if (ageSeconds > TIMESTAMP_TOLERANCE_SECONDS) {
    return `Its timestamp is ${age(ageSeconds)} old. Many providers' libraries refuse a signature older than a few minutes (often ${limit}) as a possible replay, so a server checking it that way would turn this request away, though the signature itself matches.`;
  }
  if (ageSeconds < -TIMESTAMP_TOLERANCE_SECONDS) {
    return `Its timestamp is ${age(-ageSeconds)} in the future. A server that allows ${limit} minutes either way would turn this request away; check the sender's clock.`;
  }
  return undefined;
}

const WHY_DIFFERENT =
  "The usual causes: the body was parsed and written out again before it was signed (whitespace, key order and escaping all count), the secret belongs to another endpoint or to test rather than live mode, or the value was cut short when it was copied.";

/** What a provider check's result means. */
export function explainProviderCheck(
  preset: SignaturePreset,
  result: {
    valid: boolean;
    missing: string | null;
    unreadable?: string | null;
    ageSeconds?: number | null;
  }
): SignatureVerdict {
  const warning = timestampWarning(preset, result.ageSeconds);
  if (result.valid) {
    return {
      outcome: "ok",
      title: warning
        ? (result.ageSeconds ?? 0) < 0
          ? "Signature valid, timestamp in the future"
          : "Signature valid, timestamp too old"
        : "Signature valid",
      detail: `The ${preset.label} signature matches this payload and secret, byte for byte.`,
      ...(warning ? { warning } : {}),
    };
  }
  if (result.unreadable) {
    return {
      outcome: "failed",
      title: `The ${preset.header} header is not in ${preset.label}'s form`,
      detail: `${preset.label} sends ${preset.header} as ${result.unreadable}, and the value pasted here does not have those parts, so there is nothing to compare. Paste the header exactly as it arrived, every part of it.`,
      ...(warning ? { warning } : {}),
    };
  }
  if (result.missing) {
    return {
      outcome: "failed",
      title: "No signature in these headers",
      detail: `${preset.label} sends its signature in the ${result.missing} header, and the headers pasted here do not have it.`,
    };
  }
  return {
    outcome: "failed",
    title: "Signature does not match",
    detail: `This signature was not made from this exact payload with this secret${preset.needsUrl ? " and URL" : ""}. ${WHY_DIFFERENT}`,
    ...(warning ? { warning } : {}),
  };
}

/** What comparing a computed HMAC with a pasted signature means. */
export function explainComparison(match: boolean): SignatureVerdict {
  return match
    ? {
        outcome: "ok",
        title: "Signatures match",
        detail: "The signature you pasted is the HMAC of this payload under this secret.",
      }
    : {
        outcome: "failed",
        title: "Signatures differ",
        detail: `The signature you pasted is not the HMAC of this payload under this secret, in this algorithm and encoding. ${WHY_DIFFERENT}`,
      };
}
