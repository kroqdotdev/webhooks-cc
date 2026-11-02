import { createHash } from "node:crypto";
import { PostHog } from "posthog-node";

/**
 * Server-side product analytics: account events sent to PostHog from the web
 * app, keyed by the account's user id (the same id the browser identifies
 * with). They need no browser storage, so they do not depend on the visitor's
 * cookie choice; /privacy describes them. Only ids, our own codes and counts
 * go in: never request or email contents, tokens, or customer URLs.
 *
 * On by default in production builds when the PostHog key is set, off
 * elsewhere so local runs and tests stay out of the project. ANALYTICS_SERVER
 * set to true turns it on outside production, false turns it off.
 *
 * Capturing never throws and never waits: posthog-node batches in memory and
 * flushes every few seconds, so events still queued when the process stops
 * are lost.
 */

const HOST = "https://eu.i.posthog.com";

const globalForAnalytics = globalThis as unknown as { __posthogServer?: PostHog | null };

export function serverAnalyticsEnabled(): boolean {
  const flag = process.env.ANALYTICS_SERVER;
  if (flag === "false" || flag === "0") return false;
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return false;
  return process.env.NODE_ENV === "production" || flag === "true" || flag === "1";
}

function client(): PostHog | null {
  if (globalForAnalytics.__posthogServer !== undefined) return globalForAnalytics.__posthogServer;
  globalForAnalytics.__posthogServer = serverAnalyticsEnabled()
    ? new PostHog(process.env.NEXT_PUBLIC_POSTHOG_KEY as string, {
        host: HOST,
        flushAt: 50,
        flushInterval: 5_000,
        // The daily report queues a page of accounts at a time.
        maxQueueSize: 5_000,
        // The server's address says nothing about where the person is.
        disableGeoip: true,
      })
    : null;
  return globalForAnalytics.__posthogServer;
}

export interface ServerEvent {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
  /** Person properties to set, and to set only when not set yet. */
  set?: Record<string, unknown>;
  setOnce?: Record<string, unknown>;
  groups?: Record<string, string>;
  timestamp?: Date;
  /** A stable id, so PostHog drops a resend of the same event. */
  uuid?: string;
  /** No person profile, for events no account is behind (an agent's sandbox). */
  personless?: boolean;
}

export function captureServerEvent(input: ServerEvent): void {
  const posthog = client();
  if (!posthog) return;
  try {
    const properties: Record<string, unknown> = { ...input.properties, $lib_custom: "web-server" };
    if (input.set) properties.$set = input.set;
    if (input.setOnce) properties.$set_once = input.setOnce;
    if (input.personless) properties.$process_person_profile = false;
    posthog.capture({
      distinctId: input.distinctId,
      event: input.event,
      properties,
      groups: input.groups,
      timestamp: input.timestamp,
      uuid: input.uuid,
    });
  } catch (error) {
    console.warn("[analytics] capture failed:", error instanceof Error ? error.message : error);
  }
}

/**
 * Sends whatever is queued and rejects when PostHog refused it, so the
 * reporter can give the period back. posthog-node may already have sent
 * earlier batches on its own timer; a failure there is not seen here.
 */
export async function flushServerAnalyticsOrThrow(): Promise<void> {
  await client()?.flush();
}

/** Sends whatever is queued, best effort. */
export async function flushServerAnalytics(): Promise<void> {
  try {
    await client()?.flush();
  } catch (error) {
    console.warn("[analytics] flush failed:", error instanceof Error ? error.message : error);
  }
}

/**
 * A name-based UUID (version 8 layout over SHA-256), so the same report always
 * gets the same event id and PostHog drops a resend.
 */
export function stableEventUuid(name: string): string {
  const hash = createHash("sha256").update(`webhooks.cc analytics:${name}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x80;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Which client made a request, from its user agent: our CLI and SDKs name
 * themselves, the TypeScript SDK and MCP server run on Node's fetch, and
 * Zapier and Make call from their own platforms.
 */
export function clientFromUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) return "unknown";
  if (userAgent.startsWith("whk-cli/")) return "cli";
  if (userAgent.startsWith("webhooks-cc-python/")) return "python_sdk";
  if (userAgent.startsWith("webhooks-cc-go/")) return "go_sdk";
  if (/zapier/i.test(userAgent)) return "zapier";
  if (/make\.com|integromat/i.test(userAgent)) return "make";
  if (/^Mozilla\//.test(userAgent)) return "browser";
  if (userAgent === "node" || /undici|node-fetch|^Node\.js/i.test(userAgent)) return "node";
  return "other";
}

interface AuditRowForAnalytics {
  actor_type: "user" | "polar" | "system" | "agent";
  actor_user_id: string | null;
  via: "session" | "api_key" | "agent_token" | null;
  user_agent: string | null;
  action: string;
  outcome: string;
  team_id: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Metadata that never goes to analytics, though the audit trail keeps it:
 * addresses, domains and names people or agents chose, and refusal messages,
 * which can quote them. Any other string that looks like an address or a URL is
 * dropped too.
 */
const AUDIT_METADATA_DENYLIST = new Set([
  "reason",
  "client_name",
  "clientName",
  "invited_email",
  "email_domain",
  "login_hint_domain",
  "verified_host",
  "verifiedHost",
  "domain",
  "url",
  "name",
]);

function looksPersonal(value: string): boolean {
  return value.includes("@") || value.includes("://");
}

/**
 * Mirrors an audit event (lib/audit.ts) to PostHog. Every route that changes
 * account, team, billing, API key or endpoint state already records one, from
 * the dashboard, the API, the CLI, the SDKs, the MCP server and agents alike,
 * so this covers every client without call sites of its own. Polar events are
 * sent by the billing mapping (lib/analytics-billing.ts) instead, and system
 * events are not product use.
 */
export function captureAuditEvent(row: AuditRowForAnalytics): void {
  const event = auditAnalyticsEvent(row);
  if (event) captureServerEvent(event);
}

/** The analytics event for an audit row, or null for rows that are not product use. */
export function auditAnalyticsEvent(row: AuditRowForAnalytics): ServerEvent | null {
  if (row.actor_type === "polar" || row.actor_type === "system") return null;
  const userId = row.actor_user_id;
  if (row.actor_type === "user" && !userId) return null;
  // Refusals of anonymous agents (rate limits, bad proofs of work) are abuse,
  // not use; a flood of them must not become a flood of analytics.
  if (!userId && row.outcome !== "ok") return null;

  const properties: Record<string, unknown> = {
    outcome: row.outcome,
    via: row.via ?? "agent",
    client: row.via === "agent_token" ? "agent" : clientFromUserAgent(row.user_agent),
  };
  if (row.team_id) properties.team_id = row.team_id;
  for (const [key, value] of Object.entries(row.metadata)) {
    if (AUDIT_METADATA_DENYLIST.has(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") properties[key] = value;
    else if (typeof value === "string" && !looksPersonal(value)) {
      properties[key] = value.slice(0, 200);
    } else if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string" && !looksPersonal(item))
    ) {
      properties[key] = value.slice(0, 20);
    }
  }

  // A deleted account's analytics stay, but no longer name the person.
  const forget = row.action === "account.deleted" && row.outcome === "ok" && userId;
  if (forget) properties.$unset = ["email"];

  return {
    // An agent with no account behind it yet is counted by its registration,
    // without a person profile.
    distinctId: userId ?? `agent:${row.target_id ?? "unknown"}`,
    event: row.action,
    properties,
    groups: row.team_id ? { team: row.team_id } : undefined,
    personless: !userId,
  };
}
