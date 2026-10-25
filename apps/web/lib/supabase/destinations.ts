import type { Condition } from "@webhooks-cc/sdk";
import { decryptSigningSecret, encryptSigningSecret, isSigningKeyConfigured } from "@/lib/crypto";
import {
  decryptOwnerHeaders,
  encryptOwnerHeaders,
  maskOwnerHeaders,
} from "@/lib/forwarding/owner-headers";
import { generateForwardSecret } from "@/lib/forwarding/sign";
import { createAdminClient } from "./admin";
import type { Database, DestinationFormat, Json } from "./database";

/**
 * Where an endpoint's captures go (migration 00063): any number of
 * destinations, each with its own URL, what it receives (kinds and a
 * filter), how (format and templates), its own secret and headers, retries
 * and order, an optional "at most one every N seconds" and an optional delay.
 * capture_webhook() queues a delivery per destination; the worker sends them
 * (lib/forwarding/worker.ts).
 *
 * The endpoint's old fields still work for API clients that set them:
 * forward* stand for the primary destination (the one marked 'forward', or
 * the first that is not the notification one) and notificationUrl for the
 * destination marked 'notify'.
 */

type DestinationRow = Database["public"]["Tables"]["endpoint_destinations"]["Row"];
type DestinationUpdate = Database["public"]["Tables"]["endpoint_destinations"]["Update"];

/** How many destinations an endpoint may have. */
export const MAX_DESTINATIONS = 10;

export type DestinationFormatSetting = "auto" | DestinationFormat;
export const DESTINATION_FORMAT_SETTINGS: readonly DestinationFormatSetting[] = [
  "auto",
  "as_received",
  "json",
  "chat",
  "template",
  "postmark",
  "sendgrid",
  "mailgun",
  "cloudmailin",
];

export interface DestinationFilter {
  logic: "and" | "or";
  conditions: Condition[];
}

export interface Destination {
  id: string;
  endpointId: string;
  position: number;
  name: string | null;
  enabled: boolean;
  url: string;
  /** Whether a signing secret exists (never the secret). */
  hasSecret: boolean;
  /** Whether a Mailgun signing key is saved (never the key). */
  hasMailgunSigningKey: boolean;
  http: boolean;
  email: boolean;
  /** "auto" picks from the URL. */
  format: DestinationFormatSetting;
  filter: DestinationFilter | null;
  /** The body for format "template": a JSON value with {{ placeholders }}. */
  bodyTemplate: Json | null;
  /** The chat message's text; null keeps the standard message. */
  messageTemplate: string | null;
  /** Names and masked values. */
  headers: { name: string; value: string }[];
  appendPath: boolean;
  retrySeconds: number;
  keepOrder: boolean;
  sentField: string | null;
  throttleSeconds: number;
  delaySeconds: number;
  /** Which old endpoint field this destination stands for, if any. */
  role: "forward" | "notify" | null;
  createdAt: number;
  updatedAt: number;
}

/** A header as submitted; a null value keeps the stored value of that name. */
export interface DestinationHeaderInput {
  name: string;
  value: string | null;
}

/** Fields of a destination to create or change, already validated. */
export interface DestinationChanges {
  position?: number;
  name?: string | null;
  enabled?: boolean;
  url?: string;
  http?: boolean;
  email?: boolean;
  format?: DestinationFormatSetting;
  filter?: DestinationFilter | null;
  bodyTemplate?: Json | null;
  messageTemplate?: string | null;
  headers?: DestinationHeaderInput[];
  appendPath?: boolean;
  retrySeconds?: number;
  keepOrder?: boolean;
  sentField?: string | null;
  throttleSeconds?: number;
  delaySeconds?: number;
  /** The owner's Mailgun signing key (format "mailgun"); null removes it. */
  mailgunSigningKey?: string | null;
}

/** Thrown when a submitted header keeps a value (null) that is not stored under its name. */
export class DestinationHeaderValueMissingError extends Error {}

/** Thrown when an endpoint already has MAX_DESTINATIONS. */
export class TooManyDestinationsError extends Error {
  constructor() {
    super(`An endpoint can send to at most ${MAX_DESTINATIONS} destinations.`);
  }
}

const COLUMNS =
  "id, endpoint_id, position, name, enabled, url, secret_encrypted, http, email, format, filter, body_template, message_template, headers_encrypted, append_path, retry_seconds, keep_order, sent_field, throttle_seconds, delay_seconds, last_queued_at, legacy_role, created_at, updated_at, mailgun_key_encrypted";

/** PostgREST returns bytea as "\\x..." hex text. */
export function byteaToBuffer(value: string): Buffer {
  return value.startsWith("\\x")
    ? Buffer.from(value.slice(2), "hex")
    : Buffer.from(value, "base64");
}

function toBytea(bytes: Buffer): string {
  return `\\x${bytes.toString("hex")}`;
}

function maskedHeaders(encrypted: string | null): { name: string; value: string }[] {
  if (!encrypted) return [];
  try {
    return maskOwnerHeaders(decryptOwnerHeaders(byteaToBuffer(encrypted)));
  } catch {
    return [];
  }
}

function millis(value: string | null): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function toFilter(value: Json | null): DestinationFilter | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { logic?: unknown; conditions?: unknown };
  if (!Array.isArray(record.conditions) || record.conditions.length === 0) return null;
  return {
    logic: record.logic === "or" ? "or" : "and",
    conditions: record.conditions as unknown as Condition[],
  };
}

export function toDestination(row: DestinationRow): Destination {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    position: row.position,
    name: row.name,
    enabled: row.enabled,
    url: row.url,
    hasSecret: !!row.secret_encrypted,
    hasMailgunSigningKey: !!row.mailgun_key_encrypted,
    http: row.http,
    email: row.email,
    format: row.format ?? "auto",
    filter: toFilter(row.filter),
    bodyTemplate: row.body_template,
    messageTemplate: row.message_template,
    headers: maskedHeaders(row.headers_encrypted),
    appendPath: row.append_path,
    retrySeconds: row.retry_seconds,
    keepOrder: row.keep_order,
    sentField: row.sent_field,
    throttleSeconds: row.throttle_seconds,
    delaySeconds: row.delay_seconds,
    role: row.legacy_role,
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
  };
}

function byPosition(a: DestinationRow, b: DestinationRow): number {
  return a.position - b.position || a.created_at.localeCompare(b.created_at);
}

async function rowsFor(endpointId: string): Promise<DestinationRow[]> {
  const { data, error } = await createAdminClient()
    .from("endpoint_destinations")
    .select(COLUMNS)
    .eq("endpoint_id", endpointId)
    .returns<DestinationRow[]>();
  if (error) throw error;
  return (data ?? []).sort(byPosition);
}

async function rowFor(endpointId: string, id: string): Promise<DestinationRow | null> {
  const { data, error } = await createAdminClient()
    .from("endpoint_destinations")
    .select(COLUMNS)
    .eq("endpoint_id", endpointId)
    .eq("id", id)
    .returns<DestinationRow>()
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** An endpoint's destinations, in their order. */
export async function listDestinations(endpointId: string): Promise<Destination[]> {
  return (await rowsFor(endpointId)).map(toDestination);
}

export async function getDestination(endpointId: string, id: string): Promise<Destination | null> {
  const row = await rowFor(endpointId, id);
  return row ? toDestination(row) : null;
}

/** The stored headers merged with submitted ones (a null value keeps the stored value). */
function mergeHeaders(
  storedEncrypted: string | null,
  submitted: DestinationHeaderInput[]
): string | null {
  const stored = new Map(
    (storedEncrypted ? decryptOwnerHeaders(byteaToBuffer(storedEncrypted)) : []).map(
      ([name, value]) => [name.toLowerCase(), value]
    )
  );
  const next: [string, string][] = [];
  for (const header of submitted) {
    const value = header.value ?? stored.get(header.name.toLowerCase());
    if (value === undefined) {
      throw new DestinationHeaderValueMissingError(`Enter a value for ${header.name}.`);
    }
    next.push([header.name, value]);
  }
  const encrypted = encryptOwnerHeaders(next);
  return encrypted ? toBytea(encrypted) : null;
}

function columnsFor(changes: DestinationChanges, storedHeaders: string | null): DestinationUpdate {
  const update: DestinationUpdate = {};
  if (changes.position !== undefined) update.position = changes.position;
  if (changes.name !== undefined) update.name = changes.name;
  if (changes.enabled !== undefined) update.enabled = changes.enabled;
  if (changes.url !== undefined) update.url = changes.url;
  if (changes.http !== undefined) update.http = changes.http;
  if (changes.email !== undefined) update.email = changes.email;
  if (changes.format !== undefined)
    update.format = changes.format === "auto" ? null : changes.format;
  if (changes.filter !== undefined) update.filter = (changes.filter as unknown as Json) ?? null;
  if (changes.bodyTemplate !== undefined) update.body_template = changes.bodyTemplate;
  if (changes.messageTemplate !== undefined) update.message_template = changes.messageTemplate;
  if (changes.headers !== undefined) {
    update.headers_encrypted = mergeHeaders(storedHeaders, changes.headers);
  }
  if (changes.appendPath !== undefined) update.append_path = changes.appendPath;
  if (changes.retrySeconds !== undefined) update.retry_seconds = changes.retrySeconds;
  if (changes.keepOrder !== undefined) update.keep_order = changes.keepOrder;
  if (changes.sentField !== undefined) update.sent_field = changes.sentField;
  if (changes.throttleSeconds !== undefined) update.throttle_seconds = changes.throttleSeconds;
  if (changes.delaySeconds !== undefined) update.delay_seconds = changes.delaySeconds;
  if (changes.mailgunSigningKey !== undefined) {
    update.mailgun_key_encrypted = changes.mailgunSigningKey
      ? toBytea(encryptSigningSecret(changes.mailgunSigningKey))
      : null;
  }
  return update;
}

/**
 * Adds a destination at the end of the list, with a signing secret of its
 * own (made now, so it can go into the receiving handler before anything is
 * sent).
 */
export async function createDestination(
  endpointId: string,
  changes: DestinationChanges & { url: string },
  role: "forward" | "notify" | null = null
): Promise<Destination> {
  const existing = await rowsFor(endpointId);
  if (existing.length >= MAX_DESTINATIONS) throw new TooManyDestinationsError();
  const columns = columnsFor(changes, null);
  const position =
    changes.position ?? existing.reduce((max, row) => Math.max(max, row.position + 1), 0);
  const { data, error } = await createAdminClient()
    .from("endpoint_destinations")
    .insert({
      ...columns,
      endpoint_id: endpointId,
      url: changes.url,
      position,
      // Without SIGNING_SECRET_KEY (development) only chat messages, which
      // are not signed, can go out; the destination routes refuse the rest.
      secret_encrypted: isSigningKeyConfigured()
        ? toBytea(encryptSigningSecret(generateForwardSecret()))
        : null,
      legacy_role: role,
    })
    .select(COLUMNS)
    .returns<DestinationRow>()
    .single();
  if (error) throw error;
  return toDestination(data);
}

/** Changes a destination; null when it is not the endpoint's. */
export async function updateDestination(
  endpointId: string,
  id: string,
  changes: DestinationChanges
): Promise<Destination | null> {
  const current = await rowFor(endpointId, id);
  if (!current) return null;
  const update = columnsFor(changes, current.headers_encrypted);
  // Formats that sign need a secret; destinations made for notifications had none.
  if (!current.secret_encrypted && isSigningKeyConfigured()) {
    update.secret_encrypted = toBytea(encryptSigningSecret(generateForwardSecret()));
  }
  update.updated_at = new Date().toISOString();
  const { data, error } = await createAdminClient()
    .from("endpoint_destinations")
    .update(update)
    .eq("endpoint_id", endpointId)
    .eq("id", id)
    .select(COLUMNS)
    .returns<DestinationRow>()
    .maybeSingle();
  if (error) throw error;
  return data ? toDestination(data) : null;
}

/**
 * Removes a destination. What of it is still waiting is marked failed
 * (trigger endpoint_destinations_removed); its log rows stay.
 */
export async function deleteDestination(endpointId: string, id: string): Promise<boolean> {
  const admin = createAdminClient();
  if (!(await rowFor(endpointId, id))) return false;
  // The finished log lets go first, in batches, so the delete stays short
  // (detach_destination_log() in migration 00063). A million rows at most;
  // the delete sets whatever is left to null.
  for (let batch = 0; batch < 200; batch++) {
    const { data: detached, error } = await admin.rpc("detach_destination_log", {
      p_destination_id: id,
      p_limit: 5000,
    });
    if (error) throw error;
    if (!detached) break;
  }
  const { data, error } = await admin
    .from("endpoint_destinations")
    .delete()
    .eq("endpoint_id", endpointId)
    .eq("id", id)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Moves the destinations into the given order (ids not listed keep their place after them). */
export async function reorderDestinations(endpointId: string, ids: string[]): Promise<void> {
  const rows = await rowsFor(endpointId);
  const order = [...ids, ...rows.map((row) => row.id).filter((id) => !ids.includes(id))];
  const admin = createAdminClient();
  for (const [position, id] of order.entries()) {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row || row.position === position) continue;
    const { error } = await admin
      .from("endpoint_destinations")
      .update({ position })
      .eq("endpoint_id", endpointId)
      .eq("id", id);
    if (error) throw error;
  }
}

/** The destination's signing secret, made now when it has none. */
export async function getDestinationSecret(endpointId: string, id: string): Promise<string | null> {
  const row = await rowFor(endpointId, id);
  if (!row) return null;
  if (row.secret_encrypted) return decryptSigningSecret(byteaToBuffer(row.secret_encrypted));
  return rotateDestinationSecret(endpointId, id);
}

/** The owner's Mailgun signing key, decrypted; null when none is saved. */
export async function getDestinationMailgunKey(
  endpointId: string,
  id: string
): Promise<string | null> {
  const row = await rowFor(endpointId, id);
  return row?.mailgun_key_encrypted
    ? decryptSigningSecret(byteaToBuffer(row.mailgun_key_encrypted))
    : null;
}

/** A new signing secret; deliveries are signed with it from now on. */
export async function rotateDestinationSecret(
  endpointId: string,
  id: string
): Promise<string | null> {
  const secret = generateForwardSecret();
  const { data, error } = await createAdminClient()
    .from("endpoint_destinations")
    .update({
      secret_encrypted: toBytea(encryptSigningSecret(secret)),
      updated_at: new Date().toISOString(),
    })
    .eq("endpoint_id", endpointId)
    .eq("id", id)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0 ? secret : null;
}

/** The destination's headers in plain text, for a test delivery. */
export async function getDestinationHeaders(
  endpointId: string,
  id: string
): Promise<[string, string][]> {
  const row = await rowFor(endpointId, id);
  if (!row?.headers_encrypted) return [];
  return decryptOwnerHeaders(byteaToBuffer(row.headers_encrypted));
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export interface DestinationSummary {
  destinationId: string;
  last24h: { delivered: number; failed: number; skipped: number };
  pending: number;
}

/** Per destination: deliveries of the last 24 hours, and what is waiting now. */
export async function getDestinationSummaries(
  endpointId: string,
  now: number = Date.now()
): Promise<DestinationSummary[]> {
  const { data, error } = await createAdminClient().rpc("destination_summaries", {
    p_endpoint_id: endpointId,
    p_since: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
  });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    destinationId: row.destination_id,
    last24h: {
      delivered: row.delivered_recent,
      failed: row.failed_recent,
      skipped: row.skipped_recent,
    },
    pending: row.pending,
  }));
}

// ---------------------------------------------------------------------------
// The endpoint's old fields
// ---------------------------------------------------------------------------

/** The destination the old forward* fields stand for. */
export function primaryDestination<T extends { role: string | null; position: number }>(
  destinations: T[]
): T | null {
  return (
    destinations.find((destination) => destination.role === "forward") ??
    destinations.find((destination) => destination.role !== "notify") ??
    null
  );
}

/** The destination the old notificationUrl stands for. */
export function notificationDestination<T extends { role: string | null }>(
  destinations: T[]
): T | null {
  return destinations.find((destination) => destination.role === "notify") ?? null;
}

/** The old forwarding fields as set before (lib/supabase/endpoints.ts). */
export interface LegacyForwarding {
  forwardEnabled?: boolean;
  forwardUrl?: string | null;
  forwardHttp?: boolean;
  forwardEmail?: boolean;
  forwardFormat?: "auto" | "as_received" | "json" | "chat";
  forwardAppendPath?: boolean;
  forwardRetrySeconds?: number;
  forwardKeepOrder?: boolean;
  forwardHeaders?: DestinationHeaderInput[];
  forwardSentField?: string | null;
}

/**
 * Applies the old forward* fields to the primary destination: made on the
 * first URL (switched off until forwardEnabled says otherwise, as before),
 * changed after that. A null URL switches it off and keeps it, so its secret
 * and log stay.
 */
export async function applyLegacyForwarding(
  endpointId: string,
  fields: LegacyForwarding
): Promise<void> {
  const destinations = (await rowsFor(endpointId)).map(toDestination);
  const primary = primaryDestination(destinations);
  const changes: DestinationChanges = {
    ...(fields.forwardEnabled !== undefined ? { enabled: fields.forwardEnabled } : {}),
    ...(fields.forwardHttp !== undefined ? { http: fields.forwardHttp } : {}),
    ...(fields.forwardEmail !== undefined ? { email: fields.forwardEmail } : {}),
    ...(fields.forwardFormat !== undefined ? { format: fields.forwardFormat } : {}),
    ...(fields.forwardAppendPath !== undefined ? { appendPath: fields.forwardAppendPath } : {}),
    ...(fields.forwardRetrySeconds !== undefined
      ? { retrySeconds: fields.forwardRetrySeconds }
      : {}),
    ...(fields.forwardKeepOrder !== undefined ? { keepOrder: fields.forwardKeepOrder } : {}),
    ...(fields.forwardHeaders !== undefined ? { headers: fields.forwardHeaders } : {}),
    ...(fields.forwardSentField !== undefined ? { sentField: fields.forwardSentField } : {}),
  };
  const url = fields.forwardUrl;
  if (!primary) {
    if (!url) {
      if (fields.forwardEnabled) throw new Error("Add a URL before turning forwarding on.");
      return;
    }
    await createDestination(
      endpointId,
      {
        // As the old columns did: emails only unless forwardHttp says otherwise.
        http: false,
        email: true,
        enabled: false,
        ...changes,
        url,
      },
      "forward"
    );
    return;
  }
  if (url === null || url === "") {
    if (fields.forwardEnabled) throw new Error("Add a URL before turning forwarding on.");
    changes.enabled = false;
  } else if (url !== undefined) {
    changes.url = url;
  }
  await updateDestination(endpointId, primary.id, changes);
}

/**
 * Sets the old notificationUrl: a chat destination that sends at most one
 * message a second and does not retry, as notifications always did. Null or
 * empty removes it.
 */
export async function applyLegacyNotificationUrl(
  endpointId: string,
  url: string | null
): Promise<void> {
  const destinations = (await rowsFor(endpointId)).map(toDestination);
  const current = notificationDestination(destinations);
  if (!url) {
    if (current) await deleteDestination(endpointId, current.id);
    return;
  }
  if (current) {
    await updateDestination(endpointId, current.id, { url, enabled: true });
    return;
  }
  await createDestination(
    endpointId,
    {
      url,
      name: "Notifications",
      http: true,
      email: true,
      format: "chat",
      retrySeconds: 0,
      throttleSeconds: 1,
    },
    "notify"
  );
}
