/**
 * Analytics sees URLs everywhere (page views, referrers, autocaptured link
 * targets, the initial URL on the person) and several of ours carry secrets:
 * share links hold their token in the path (/s/{token}), the dashboard names
 * the open endpoint's slug (a guest slug is enough to read its captures),
 * Polar's checkout return adds a customer session token, and auth flows put
 * codes and tokens in the query or the fragment. So every string in an
 * event's properties is rewritten: share paths as StatOSS events are
 * (lib/observability-redact.ts), and every query parameter that is not on
 * the list below dropped, along with any fragment.
 */

import { REDACTED_SHARE_PATH, redactSharePaths } from "./observability-redact";

export { REDACTED_SHARE_PATH };

/** Query parameters analytics keeps: campaign attribution and a few of our own flags. */
const KEPT_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "fbclid",
  "ref",
  "tab",
  "upgraded",
  "subscribed",
  "capacity",
  "template",
  "error",
  "error_code",
]);

// A URL or an absolute path, then its query and/or fragment.
const URL_TAIL = /(https?:\/\/[^\s"'<>?#]*|(?<![\w.~-])\/[^\s"'<>?#]*)([?#][^\s"'<>]*)/g;

function keptQuery(tail: string): string {
  const hash = tail.indexOf("#");
  const query = (hash === -1 ? tail : tail.slice(0, hash)).replace(/^\?/, "");
  if (!query) return "";
  const kept = query.split("&").filter((pair) => {
    const name = pair.split("=", 1)[0];
    try {
      return KEPT_PARAMS.has(decodeURIComponent(name));
    } catch {
      return false;
    }
  });
  return kept.length > 0 ? `?${kept.join("&")}` : "";
}

/** The text with share tokens, unlisted query parameters and fragments taken out of its URLs. */
export function redactUrls(text: string): string {
  return redactSharePaths(text).replace(
    URL_TAIL,
    (_match, base: string, tail: string) => base + keptQuery(tail)
  );
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactUrls(value);
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactValue(item, depth + 1);
  return out;
}

/** Event fields that are ours or PostHog's own ids, never a URL. */
const UNTOUCHED_KEYS = new Set(["uuid", "event", "timestamp"]);

/**
 * posthog-js before_send: the same event with its URLs cleaned. The person
 * fields ($set, $set_once, which carry the initial URL and referrer) sit
 * beside `properties`, not in it, so every field is cleaned.
 */
export function redactAnalyticsEvent<T extends object | null>(event: T): T {
  if (!event) return event;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    out[key] = UNTOUCHED_KEYS.has(key) ? value : redactValue(value, 0);
  }
  return out as T;
}
