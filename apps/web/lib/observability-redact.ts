/**
 * Redaction shared by the server and browser StatOSS clients, applied to
 * every line and event sent. Email addresses become `[email]`, and URLs lose
 * their query string and fragment: a query error, a console breadcrumb, an
 * error message or a Referer can quote either, and a query can carry a guest
 * endpoint's slug or a token. A share link's path is its capability, so
 * /s/{token} keeps only the route. No Node imports, so the browser bundle can
 * use it.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// An absolute URL or a path, then `?` or `#` and what follows up to a space,
// a quote, a bracket or a backslash (so a JSON escape or a stack frame's
// closing parenthesis survives).
const URL_QUERY = /((?:https?:\/\/|\/)[^\s"'<>?#\\]*)[?#][^\s"'<>\\)]*/g;
const SHARE_TOKEN_IN_URL = /\/s\/[A-Za-z0-9_-]{22,64}/g;
export const REDACTED_SHARE_PATH = "/s/[token]";

export function redactEmails(text: string): string {
  return text.replace(EMAIL, "[email]");
}

export function redactSharePaths(text: string): string {
  return text.replace(SHARE_TOKEN_IN_URL, REDACTED_SHARE_PATH);
}

export function redactText(text: string): string {
  return redactSharePaths(redactEmails(text).replace(URL_QUERY, "$1"));
}

/** The event with every email address, URL query and share token in it removed. */
export function redactEvent<T>(event: T): T {
  try {
    return JSON.parse(redactText(JSON.stringify(event))) as T;
  } catch {
    return event;
  }
}
