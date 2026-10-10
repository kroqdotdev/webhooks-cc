import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database";
import { isAgentTokenRequest } from "@/lib/agent/token-requests";

/**
 * Audit trail for state-changing account, team, billing, and endpoint actions
 * (migration 00041). Each event is written to `audit_events` and printed as one
 * `[audit]` log line, so it can be found with SQL or in journald.
 *
 * Recording never throws and never changes the response: a failed insert is
 * logged and the request carries on. Only ids, our own user-facing messages,
 * and a few scalar fields go in; never request bodies, tokens, or raw Polar
 * errors (they embed the bearer token).
 */

export type AuditAction =
  | "account.deleted"
  | "api_key.created"
  | "api_key.deleted"
  | "billing.checkout_started"
  | "billing.subscription_canceled"
  | "billing.subscription_resumed"
  | "endpoint.created"
  | "endpoint.updated"
  | "endpoint.deleted"
  | "endpoint.claimed"
  | "endpoint.forward_secret_rotated"
  | "email.redelivery_queued"
  | "request.redelivery_queued"
  | "team.created"
  | "team.renamed"
  | "team.deleted"
  | "team.endpoint_shared"
  | "team.endpoint_unshared"
  | "team.invite_sent"
  | "team.invite_accepted"
  | "team.invite_declined"
  | "team.member_removed"
  | "team.member_left"
  | "team.checkout_started"
  | "team.subscription_canceled"
  | "team.subscription_resumed"
  | "team.seats_changed";

/** Agent registration (auth.md) events: no signed-in user is behind most of them. */
export type AgentAuditAction =
  | "agent.registration.created"
  | "agent.registration.refused"
  | "agent.claim.requested"
  | "agent.claim.confirmed"
  | "agent.claim.refused"
  | "agent.claim.denied"
  | "agent.token.issued"
  | "agent.token.revoked"
  | "agent.registration.revoked"
  | "agent.sandbox.endpoint_created"
  | "agent.sandbox.endpoint_deleted"
  | "agent.sandbox.full";

export type AuditOutcome = "ok" | "refused" | "error";

export interface AuditUserActionInput {
  action: AuditAction;
  /** HTTP status the route answered with; 2xx is ok, 4xx refused, 5xx error. */
  status: number;
  /** The error message shown to the user, for refusals. */
  reason?: string;
  teamId?: string | null;
  targetUserId?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

const MAX_USER_AGENT = 256;
/** Longest string kept in agent event metadata; agents choose some of it (client_name). */
const MAX_AGENT_METADATA_STRING = 100;
const MAX_TARGET_ID = 128;
const MAX_REASON = 300;

// Polar payload fields worth keeping. Everything else (emails, addresses,
// product descriptions) is dropped.
const POLAR_FIELDS = [
  "id",
  "status",
  "seats",
  "subscription_id",
  "customer_id",
  "cancel_at_period_end",
  "billing_reason",
  "total_amount",
  "currency",
] as const;

type AuditRow = {
  actor_type: "user" | "polar" | "system" | "agent";
  actor_user_id: string | null;
  via: "session" | "api_key" | "agent_token" | null;
  user_agent: string | null;
  action: string;
  outcome: AuditOutcome;
  team_id: string | null;
  target_user_id: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
};

export function outcomeForStatus(status: number): AuditOutcome {
  if (status >= 500) return "error";
  if (status >= 400) return "refused";
  return "ok";
}

/**
 * API keys are `whcc_` bearers; every other bearer is a dashboard session JWT.
 * An agent access token is a `whcc_` key too, told apart by the bearer check
 * that admitted the request.
 */
export function requestVia(request: Request): "session" | "api_key" | "agent_token" {
  if (isAgentTokenRequest(request)) return "agent_token";
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer whcc_") ? "api_key" : "session";
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/** Records an action a signed-in user took through an API route. */
export async function auditUserAction(
  request: Request,
  actorUserId: string,
  input: AuditUserActionInput
): Promise<void> {
  const metadata: Record<string, unknown> = { ...input.metadata, status: input.status };
  const reason = truncate(input.reason, MAX_REASON);
  if (reason) metadata.reason = reason;

  await recordAuditEvent({
    actor_type: "user",
    actor_user_id: actorUserId,
    via: requestVia(request),
    user_agent: truncate(request.headers.get("user-agent"), MAX_USER_AGENT),
    action: input.action,
    outcome: outcomeForStatus(input.status),
    team_id: input.teamId ?? null,
    target_user_id: input.targetUserId ?? null,
    target_id: truncate(input.targetId, MAX_TARGET_ID),
    metadata,
  });
}

/**
 * Records an agent registration, claim or sandbox event. The actor is the
 * agent unless `actorUserId` is set (a signed-in human confirming a claim).
 * Only ids and our own codes go in: never credentials, claim tokens, codes,
 * or full email addresses (`metadata.email_domain` at most).
 */
export async function auditAgentEvent(
  request: Request,
  input: {
    action: AgentAuditAction;
    /** HTTP status the route answered with; 2xx is ok, 4xx refused, 5xx error. */
    status: number;
    /** The registration id (agent_claims for the legacy email flow). */
    targetId?: string | null;
    actorUserId?: string | null;
    targetUserId?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await recordAuditEvent({
    actor_type: input.actorUserId ? "user" : "agent",
    actor_user_id: input.actorUserId ?? null,
    via: input.actorUserId ? requestVia(request) : null,
    user_agent: truncate(request.headers.get("user-agent"), MAX_USER_AGENT),
    action: input.action,
    outcome: outcomeForStatus(input.status),
    team_id: null,
    target_user_id: input.targetUserId ?? null,
    target_id: truncate(input.targetId, MAX_TARGET_ID),
    metadata: { ...boundStrings(input.metadata ?? {}), status: input.status },
  });
}

/**
 * Cuts string values to MAX_AGENT_METADATA_STRING. Agents pick values such
 * as client_name, and a row over the metadata size check (4 KB) would be
 * rejected and lost, so an agent could otherwise keep itself out of the trail.
 */
function boundStrings(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      typeof value === "string" ? value.slice(0, MAX_AGENT_METADATA_STRING) : value,
    ])
  );
}

/** The domain of an email address, for audit metadata (never the whole address). */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at === -1
    ? null
    : email
        .slice(at + 1)
        .toLowerCase()
        .slice(0, 253);
}

/** `customer_seat.claimed` becomes `polar.customer_seat.claimed`. */
export function polarAuditAction(eventType: string): string {
  const cleaned = eventType.toLowerCase().replace(/[^a-z0-9_.]/g, "_");
  return `polar.${cleaned}`.slice(0, 64);
}

function pickPolarFields(data: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of POLAR_FIELDS) {
    const value = data[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      picked[key] = value;
    }
  }
  return picked;
}

function seatUserId(data: Record<string, unknown>): string | null {
  for (const key of ["seat_metadata", "metadata"]) {
    const value = data[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const userId = (value as Record<string, unknown>).userId;
      if (typeof userId === "string" && userId.length > 0) return userId;
    }
  }
  return null;
}

/** Records a verified Polar webhook delivery and whether applying it succeeded. */
export async function auditPolarEvent(input: {
  eventType: string;
  teamId: string | null;
  data: Record<string, unknown>;
  outcome: AuditOutcome;
}): Promise<void> {
  await recordAuditEvent({
    actor_type: "polar",
    actor_user_id: null,
    via: null,
    user_agent: null,
    action: polarAuditAction(input.eventType),
    outcome: input.outcome,
    team_id: input.teamId,
    target_user_id: seatUserId(input.data),
    target_id: typeof input.data.id === "string" ? truncate(input.data.id, MAX_TARGET_ID) : null,
    metadata: pickPolarFields(input.data),
  });
}

async function recordAuditEvent(row: AuditRow): Promise<void> {
  console.info(`[audit] ${JSON.stringify(row)}`);
  try {
    const { error } = await createAdminClient()
      .from("audit_events")
      .insert({ ...row, metadata: row.metadata as Json });
    if (error) {
      console.error(`[audit] insert failed for ${row.action}: ${error.message}`);
    }
  } catch (error) {
    console.error(
      `[audit] insert failed for ${row.action}:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}
