import { getClientIp, rateLimitIpBucket } from "@/lib/rate-limit";

/**
 * How often an unsigned refusal at the token endpoint is written to
 * audit_events (lib/agent/org-id-jag-grant.ts). Anyone can send assertions
 * naming an issuer under a configured prefix, each refused before its
 * signature is checked, and an audit row per request would let one address
 * fill the table. So each (address, code) writes at most one row a minute
 * per process (IPv6 by /64); the refusals in between are counted, and the next row that
 * pair writes carries the count as `suppressed`. Counts still waiting when
 * an entry is evicted (more than MAX_ENTRIES pairs a minute) are dropped.
 */

const WINDOW_MS = 60_000;
const MAX_ENTRIES = 5000;

const entries = new Map<string, { until: number; suppressed: number }>();

/** Drops the counters (tests). */
export function clearRefusalAuditGate(): void {
  entries.clear();
}

/**
 * Whether this refusal is written, and how many of the pair's refusals went
 * unwritten since its last row.
 */
export function refusalAuditGate(
  request: Request,
  code: string,
  now = Date.now()
): { record: true; suppressed: number } | { record: false } {
  // By the rate limits' bucket: an IPv6 client holds a whole /64.
  const key = `${rateLimitIpBucket(getClientIp(request))}#${code}`;
  const entry = entries.get(key);
  if (entry && entry.until > now) {
    entry.suppressed += 1;
    return { record: false };
  }
  const suppressed = entry?.suppressed ?? 0;
  entries.delete(key);
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, { until: now + WINDOW_MS, suppressed: 0 });
  return { record: true, suppressed };
}
