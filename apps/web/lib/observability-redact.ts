/**
 * Redaction shared by the server and browser StatOSS clients, applied to
 * every line and event sent. Email addresses become `[email]`, and URLs lose
 * their query string and fragment: a query error, a console breadcrumb, an
 * error message or a Referer can quote either, and a query can carry a guest
 * endpoint's slug or a token. A share link's path is its capability, so
 * /s/{token} keeps only the route. The free tools (lib/tools) call Discord and
 * Slack webhook URLs from the browser, and those are credentials in a path
 * too, so a breadcrumb or an error message that quotes one keeps only the
 * host and route. No Node imports, so the browser bundle can use it.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// An absolute URL or a path, then `?` or `#` and what follows up to a space,
// a quote, a bracket or a backslash (so a JSON escape or a stack frame's
// closing parenthesis survives).
const URL_QUERY = /((?:https?:\/\/|\/)[^\s"'<>?#\\]*)[?#][^\s"'<>\\)]*/g;
const SHARE_TOKEN_IN_URL = /\/s\/[A-Za-z0-9_-]{22,64}/g;
export const REDACTED_SHARE_PATH = "/s/[token]";
// Discord: /api/webhooks/{id}/{token}, with or without an API version.
const DISCORD_WEBHOOK_PATH = /\/api(?:\/v\d+)?\/webhooks\/\d+(?:\/[A-Za-z0-9_-]+)*/g;
export const REDACTED_DISCORD_WEBHOOK_PATH = "/api/webhooks/[webhook]";
// Slack: incoming webhooks under /services, workflow webhooks under /triggers and /workflows.
const SLACK_WEBHOOK_URL =
  /(hooks\.slack(?:-gov)?\.com\/(?:services|triggers|workflows))\/[A-Za-z0-9_/-]+/g;
export const REDACTED_SLACK_WEBHOOK = "[webhook]";

export function redactEmails(text: string): string {
  return text.replace(EMAIL, "[email]");
}

export function redactSharePaths(text: string): string {
  return text.replace(SHARE_TOKEN_IN_URL, REDACTED_SHARE_PATH);
}

/** Discord and Slack webhook URLs with the parts that grant access to them removed. */
export function redactWebhookUrls(text: string): string {
  return text
    .replace(DISCORD_WEBHOOK_PATH, REDACTED_DISCORD_WEBHOOK_PATH)
    .replace(SLACK_WEBHOOK_URL, `$1/${REDACTED_SLACK_WEBHOOK}`);
}

export function redactText(text: string): string {
  return redactWebhookUrls(redactSharePaths(redactEmails(text).replace(URL_QUERY, "$1")));
}

/** The event with every email address, URL query and share token in it removed. */
export function redactEvent<T>(event: T): T {
  try {
    return JSON.parse(redactText(JSON.stringify(event))) as T;
  } catch {
    return event;
  }
}
