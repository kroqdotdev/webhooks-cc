import { formatDuration, type SenderTime } from "./timing";

/**
 * How the dashboard writes delivery times, lags and answers: shared by the
 * journey strip, the request's Deliveries tab and the endpoint's delivery
 * log, so one request reads the same everywhere. Pure functions.
 */

/** The dashboard's own storage key for the UTC toggle of delivery times. */
export const DELIVERY_TIME_UTC_KEY = "deliveries_time_utc";

/** How long a delivery waits for an answer (config.ts FORWARD_TIMEOUT_MS; that file is server-only). */
export const FORWARD_TIMEOUT_SECONDS = 15;

export interface ClockOptions {
  /** ISO UTC instead of local time. */
  utc?: boolean;
  /** Leave the milliseconds out (a time the sender gave in whole seconds). */
  wholeSeconds?: boolean;
  /** The reference "today" for the date prefix; defaults to now. */
  now?: number;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * A moment as the delivery views show it: "17:25:09.874" in local time, with
 * the date in front when it is not today ("Oct 8, 17:37:12.410"); as ISO UTC
 * ("2026-10-10T15:25:09.874Z") when `utc` is set.
 */
export function formatClock(ms: number, options: ClockOptions = {}): string {
  const date = new Date(ms);
  if (options.utc) {
    const iso = date.toISOString();
    return options.wholeSeconds ? iso.replace(/\.\d{3}Z$/, "Z") : iso;
  }
  const time =
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    (options.wholeSeconds ? "" : `.${pad(date.getMilliseconds(), 3)}`);
  const now = new Date(options.now ?? Date.now());
  if (sameLocalDay(date, now)) return time;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/** "about 17:33": a time that is only an estimate, such as the next try. */
export function formatAbout(ms: number, utc = false): string {
  const date = new Date(ms);
  if (utc) return `about ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
  return `about ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "in 8 min", "in 30 s", "now": how far off a moment is. */
export function formatIn(ms: number, now: number): string {
  const seconds = Math.round((ms - now) / 1000);
  if (seconds <= 0) return "now";
  if (seconds < 60) return `in ${seconds} s`;
  if (seconds < 3600) return `in ${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `in ${Math.round(seconds / 3600)} h`;
  return `in ${Math.round(seconds / 86_400)} d`;
}

/** "1,284": a count with thousands separators. */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** The summary's counts stop here; a count at the cap reads "100,000+". */
export const COUNT_CAP = 100_000;

/** "1,284", or "100,000+" for a count the summary stopped counting at. */
export function formatCappedCount(n: number): string {
  return n >= COUNT_CAP ? `${formatCount(COUNT_CAP)}+` : formatCount(n);
}

/** "1 try", "9 tries". */
export function formatTries(n: number): string {
  return n === 1 ? "1 try" : `${n} tries`;
}

/** The delivery never got an HTTP answer because the destination did not answer in time. */
export function isTimeoutError(error: string | null | undefined): boolean {
  return !!error && /no answer within|timed out|timeout/i.test(error);
}

/** The delivery could not reach the destination at all (DNS, refused, TLS). */
export function isConnectionError(error: string | null | undefined): boolean {
  return (
    !!error &&
    !isTimeoutError(error) &&
    /refused|resolve|not found|unreachable|reset|tls|certificate|econn|enotfound|network/i.test(
      error
    )
  );
}

export type AnswerKind = "status" | "timeout" | "unreachable" | "refused" | "none";

/**
 * What the destination answered on a try: the status code, "No answer" for a
 * timeout, "Unreachable" for a connection failure, "Not sent" when the
 * delivery was refused before any try, "..." while nothing has happened.
 */
export function describeAnswer(
  status: number | null,
  error: string | null,
  attempts: number
): { label: string; kind: AnswerKind } {
  if (status !== null) return { label: String(status), kind: "status" };
  if (attempts === 0) return { label: "...", kind: "none" };
  if (isTimeoutError(error)) return { label: "No answer", kind: "timeout" };
  if (isConnectionError(error)) return { label: "Unreachable", kind: "unreachable" };
  if (error) return { label: "Not sent", kind: "refused" };
  return { label: "...", kind: "none" };
}

/** A 2xx answer, which is what counts as accepted. */
export function isAccepted(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

/**
 * The lag from the sender's own timestamp to our receipt, for a label on the
 * journey or a log cell: "197 ms" when the source carries milliseconds,
 * "within 1 s" or "about 3 s" when it has whole seconds, "-35 ms" when the
 * sender's clock is ahead of ours.
 */
export function formatSenderLag(sent: SenderTime, receivedAt: number): string {
  const lag = receivedAt - sent.at;
  if (sent.wholeSeconds) {
    if (lag >= 0 && lag < 1000) return "within 1 s";
    const seconds = Math.floor(Math.abs(lag) / 1000);
    const about = seconds < 60 ? `${seconds} s` : formatDuration(seconds * 1000);
    return lag >= 0 ? `about ${about}` : `about -${about}`;
  }
  return lag >= 0 ? formatDuration(lag) : `-${formatDuration(lag)}`;
}

/** Sources that are headers with whole seconds, or an email's Date header. */
const HEADER_SOURCES = new Set([
  "webhook-timestamp",
  "svix-timestamp",
  "x-slack-request-timestamp",
  "stripe-signature",
  "date",
]);

/** Whether a recorded sender source is a header (whole seconds) rather than a body field. */
export function isHeaderSource(source: string): boolean {
  return HEADER_SOURCES.has(source.toLowerCase());
}

/** A SenderTime from the columns the API stores for a delivery. */
export function senderTimeFromRecord(
  senderAt: number | null,
  senderSource: string | null
): SenderTime | null {
  if (senderAt === null || !senderSource) return null;
  return { at: senderAt, source: senderSource, wholeSeconds: isHeaderSource(senderSource) };
}

/** The small line under the Sent stop: where the time was read from. */
export function describeSenderSource(source: string): string {
  if (source.toLowerCase() === "date") return "from the Date header";
  if (isHeaderSource(source)) return `sender's clock, from ${source}`;
  return `from ${source}`;
}

/** Why a negative lag is shown, for a title. */
export const CLOCKS_DIFFER_TITLE =
  "The sender's timestamp is later than our receipt: the sender's clock runs ahead of ours.";

/** "retried for 1 day", "retried for 1 hour", "never retried". */
export function describeRetryWindow(seconds: number): string {
  if (seconds <= 0) return "never retried";
  if (seconds <= 3600) return "retried for 1 hour";
  return "retried for 1 day";
}

/** "1 day" or "1 hour": how long tries continue, for the notes. */
export function retryWindowName(seconds: number): string {
  return seconds <= 3600 ? "1 hour" : "1 day";
}

/** The host and path of a URL as the lead line names it; host only for chat webhooks. */
export function targetOfUrl(url: string, format: "as_received" | "json" | "chat"): string | null {
  try {
    const parsed = new URL(url);
    if (format === "chat") return parsed.host;
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return null;
  }
}

/** "Forwarded as received to", "Forwarded as signed JSON to", "Posted as a message to". */
export function leadVerb(format: "as_received" | "json" | "chat"): string {
  if (format === "chat") return "Posted as a message to";
  if (format === "json") return "Forwarded as signed JSON to";
  return "Forwarded as received to";
}

/** The chat service a webhook URL belongs to, for sentences: "Slack", "Discord". */
export function chatServiceName(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith("discord.com") || host.endsWith("discordapp.com")) return "Discord";
  } catch {
    // Not a URL: a server, then.
  }
  return "Slack";
}
