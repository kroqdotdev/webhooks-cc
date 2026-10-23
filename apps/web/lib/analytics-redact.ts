/**
 * Share links carry their capability in the path (/s/{token}), so analytics
 * must never see one: page views, referrers and autocaptured link targets
 * all hold URLs. Every string in an event's properties is rewritten.
 */

const SHARE_TOKEN_IN_URL = /\/s\/[A-Za-z0-9_-]{22,64}/g;
export const REDACTED_SHARE_PATH = "/s/[token]";

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return value.replace(SHARE_TOKEN_IN_URL, REDACTED_SHARE_PATH);
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactValue(item, depth + 1);
  return out;
}

/** posthog-js before_send: the same event with share tokens replaced. */
export function redactShareTokens<T extends { properties?: Record<string, unknown> } | null>(
  event: T
): T {
  if (!event?.properties) return event;
  return {
    ...event,
    properties: redactValue(event.properties, 0) as Record<string, unknown>,
  };
}
