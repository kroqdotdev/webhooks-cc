/**
 * When the sender says it sent a request, and how durations read in the
 * dashboard and in chat messages. Pure functions, used by the worker (the
 * chat message and the delivery log) and by the browser (the journey strip),
 * so both read the same time from the same request.
 *
 * The sender's time comes from, in order: the JSON field the owner named
 * (`endpoints.forward_sent_field`, for a timestamp in the body such as
 * `publishedAt`), a timestamp header a known scheme sends (Standard
 * Webhooks, Svix, Stripe, Slack), or an email's Date header. Header times
 * have whole seconds only.
 */

export interface SenderTime {
  /** Milliseconds since the epoch. */
  at: number;
  /** Where it was read: the field name, or the header. */
  source: string;
  /** The timestamp has no fraction, so a lag under a second cannot be told. */
  wholeSeconds: boolean;
}

export const MAX_SENT_FIELD_CHARS = 128;

/** Why a field path cannot be used, or null. Dots separate nested keys. */
export function checkSentField(field: string): string | null {
  if (field.length === 0 || field.length > MAX_SENT_FIELD_CHARS) {
    return `Use a field name of 1 to ${MAX_SENT_FIELD_CHARS} characters.`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(field)) return "The field name has a control character.";
  if (field.split(".").some((part) => part.length === 0)) {
    return "Separate nested fields with single dots, as in data.sentAt.";
  }
  return null;
}

/** 2000-01-01 to 2100-01-01: anything outside is not a timestamp. */
const EARLIEST = 946_684_800_000;
const LATEST = 4_102_444_800_000;

function inRange(ms: number): boolean {
  return Number.isFinite(ms) && ms >= EARLIEST && ms < LATEST;
}

/** A number of seconds, milliseconds, microseconds or nanoseconds since the epoch. */
function fromEpochNumber(value: number): { at: number; wholeSeconds: boolean } | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  let ms: number;
  let wholeSeconds = false;
  if (value >= 1e17) ms = value / 1e6;
  else if (value >= 1e14) ms = value / 1e3;
  else if (value >= 1e11) ms = value;
  else {
    ms = value * 1000;
    wholeSeconds = Number.isInteger(value);
  }
  return inRange(ms) ? { at: Math.round(ms), wholeSeconds } : null;
}

const ISO_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})?$/;

/**
 * A timestamp in any of the usual shapes: an RFC 3339 or ISO 8601 date and
 * time (UTC when it names no offset), or seconds or milliseconds since the
 * epoch as a number or numeric text. Null for anything else.
 */
export function parseTimestamp(value: unknown): { at: number; wholeSeconds: boolean } | null {
  if (typeof value === "number") return fromEpochNumber(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return fromEpochNumber(Number(text));
  const match = ISO_DATE_TIME.exec(text);
  if (!match) return null;
  const [, date, time, fraction, zone] = match;
  const offset = !zone ? "Z" : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  // Date.parse reads at most milliseconds reliably.
  const millis = fraction ? fraction.slice(0, 4).padEnd(4, "0") : "";
  const at = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}${millis}${offset}`);
  if (!inRange(at)) return null;
  return { at, wholeSeconds: !fraction };
}

/** The value at a dotted path in parsed JSON; numeric parts index arrays. */
export function valueAtPath(json: unknown, path: string): unknown {
  let current: unknown = json;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return undefined;
      current = current[Number(part)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

/** Headers that carry the sender's time in a known scheme, in seconds since the epoch. */
const EPOCH_HEADERS: [header: string, source: string][] = [
  ["webhook-timestamp", "webhook-timestamp"],
  ["svix-timestamp", "svix-timestamp"],
  ["x-slack-request-timestamp", "X-Slack-Request-Timestamp"],
];

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

export interface TimedRequest {
  kind?: "http" | "email";
  headers?: Record<string, string>;
  /** The body as text; parsed only when a field is named. */
  body?: string | null;
  /** An email's Date header, as parsed at capture. */
  emailDate?: string | null;
}

/** The sender's own timestamp for one captured request, or null when it has none we can read. */
export function senderTimestamp(
  request: TimedRequest,
  field: string | null | undefined
): SenderTime | null {
  if (field && request.kind !== "email" && request.body) {
    try {
      const parsed = parseTimestamp(valueAtPath(JSON.parse(request.body), field));
      if (parsed) return { ...parsed, source: field };
    } catch {
      // Not JSON: fall through to the headers.
    }
  }
  if (request.kind === "email") {
    if (!request.emailDate) return null;
    const at = Date.parse(request.emailDate);
    return inRange(at) ? { at, source: "Date", wholeSeconds: true } : null;
  }
  for (const [name, source] of EPOCH_HEADERS) {
    const value = header(request.headers, name);
    if (value === undefined) continue;
    const parsed = /^\d{9,11}$/.test(value.trim()) ? fromEpochNumber(Number(value)) : null;
    if (parsed) return { ...parsed, source };
  }
  const stripe = header(request.headers, "stripe-signature");
  const t = stripe ? /(?:^|,)\s*t=(\d{9,11})\s*(?:,|$)/.exec(stripe) : null;
  if (t) {
    const parsed = fromEpochNumber(Number(t[1]));
    if (parsed) return { ...parsed, source: "Stripe-Signature" };
  }
  return null;
}

/**
 * A duration as the dashboard writes it: "143 ms", "0.64 s", "15.0 s",
 * "2 min 30 s", "23 h 4 min", "1 d 2 h".
 */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(abs)} ms`;
  if (abs < 10_000) return `${(abs / 1000).toFixed(2)} s`;
  if (abs < 60_000) return `${(abs / 1000).toFixed(1)} s`;
  const seconds = Math.round(abs / 1000);
  if (seconds < 3600) {
    const s = seconds % 60;
    return s ? `${Math.floor(seconds / 60)} min ${s} s` : `${Math.floor(seconds / 60)} min`;
  }
  if (seconds < 86_400) {
    const m = Math.floor((seconds % 3600) / 60);
    return m ? `${Math.floor(seconds / 3600)} h ${m} min` : `${Math.floor(seconds / 3600)} h`;
  }
  const h = Math.floor((seconds % 86_400) / 3600);
  return h ? `${Math.floor(seconds / 86_400)} d ${h} h` : `${Math.floor(seconds / 86_400)} d`;
}

/**
 * The lag from the sender's time to our receipt, as words: "197 ms after
 * publishedAt", "within 1 s of webhook-timestamp" (whole seconds),
 * "35 ms before publishedAt" when the clocks disagree.
 */
export function describeSenderLag(sent: SenderTime, receivedAt: number): string {
  const lag = receivedAt - sent.at;
  if (sent.wholeSeconds) {
    // The sender's clock dropped the fraction: anything from 0 to 999 ms reads as 0 s.
    if (lag >= 0 && lag < 1000) return `within 1 s of ${sent.source}`;
    const seconds = Math.floor(Math.abs(lag) / 1000);
    const about = seconds < 60 ? `${seconds} s` : formatDuration(seconds * 1000);
    return lag >= 0
      ? `about ${about} after ${sent.source}`
      : `about ${about} before ${sent.source}`;
  }
  return lag >= 0
    ? `${formatDuration(lag)} after ${sent.source}`
    : `${formatDuration(lag)} before ${sent.source}`;
}
