import { createAdminClient } from "./admin";
import type { Database, Json } from "./database";
import { resolveEndpointAccess } from "./teams";
import { deriveWebhookDetection } from "@/lib/webhook-detection";
import { toEmailCapture, type EmailCapture } from "@/lib/email-capture";
import { extractFromEmail, type EmailExtracts } from "@webhooks-cc/sdk/email";
import type { RequestKind } from "@/lib/supabase/search";

const FREE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Matches the daily cleanup, which deletes Pro requests after 31 days.
const PRO_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_LIST_LIMIT = 1000;

type RequestRow = Database["public"]["Tables"]["requests"]["Row"];
type SelectedRequestRow = Pick<
  RequestRow,
  | "id"
  | "endpoint_id"
  | "method"
  | "path"
  | "headers"
  | "body"
  | "body_raw"
  | "query_params"
  | "content_type"
  | "ip"
  | "size"
  | "received_at"
  | "team_id"
  | "kind"
  | "email"
> & {
  signature_verified?: boolean | null;
  signature_error?: string | null;
  signing_provider?: string | null;
};
type OwnedEndpointRow = Pick<Database["public"]["Tables"]["endpoints"]["Row"], "id" | "slug">;
/** Present when the select asked for it (the forwarding worker does). */
type SelectedRequestRowWithQuery = SelectedRequestRow & { query_raw?: string | null };
type UserPlan = Database["public"]["Tables"]["users"]["Row"]["plan"];

export interface RequestRecord {
  id: string;
  endpointId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  /** Base64-encoded raw bytes, present only for non-UTF-8 payloads */
  bodyRaw?: string;
  queryParams: Record<string, string>;
  /** The query string exactly as sent (since migration 00058; only where loaded for forwarding). */
  queryRaw?: string;
  contentType?: string;
  ip: string;
  size: number;
  receivedAt: number;
  signatureVerified?: boolean | null;
  signatureError?: string | null;
  signingProvider?: string | null;
  detectedProvider?: string | null;
  detectedEvent?: string | null;
  /** "email" for captured emails (`email` is set), "http" for everything else. */
  kind: "http" | "email";
  email?: EmailCapture | null;
  /**
   * For an email in an API response that asked for it, the one-time codes
   * and links found in it (see withEmailExtracts).
   */
  extracts?: EmailExtracts | null;
}

export interface PaginatedRequestPage {
  items: RequestRecord[];
  cursor?: string;
  hasMore: boolean;
}

export interface ClearRequestsResult {
  deleted: number;
  complete: true;
}

function parseMillis(timestamp: string): number {
  return Date.parse(timestamp);
}

function asStringRecord(value: Json): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => typeof item === "string")
  ) as Record<string, string>;
}

/**
 * Convert Postgres bytea to base64.
 *
 * PostgREST returns hex with prefix: "\\x808182"
 * Supabase Realtime (via wal2json) can return hex without prefix: "808182"
 * or a double-encoded bytea text representation: "\\x383038313832"
 *
 * Both are normalized to base64.
 */
export function byteaToBase64(value: string): string {
  const hex = value.startsWith("\\x") ? value.slice(2) : value;
  const bytes = Buffer.from(hex, "hex");

  // Realtime can serialize bytea as the text representation of the hex value,
  // then encode that string as bytea again. Since body_raw is only stored for
  // non-UTF-8 payloads, an all-hex ASCII first decode is safe to unwrap.
  if (bytes.length > 0 && bytes.length % 2 === 0 && isAsciiHex(bytes)) {
    return Buffer.from(bytes.toString("ascii"), "hex").toString("base64");
  }

  return bytes.toString("base64");
}

function isAsciiHex(bytes: Buffer): boolean {
  return bytes.every(
    (byte) =>
      (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102)
  );
}

function normalizeRequest(row: SelectedRequestRowWithQuery): RequestRecord {
  const headers = asStringRecord(row.headers);
  const body = row.body ?? undefined;
  const kind = row.kind === "email" ? "email" : "http";
  // Provider detection reads webhook headers and payloads; emails have neither.
  const detection =
    kind === "email"
      ? { detectedProvider: null, detectedEvent: null }
      : deriveWebhookDetection({
          headers,
          body,
          contentType: row.content_type ?? undefined,
        });

  return {
    id: row.id,
    endpointId: row.endpoint_id,
    method: row.method,
    path: row.path,
    headers,
    body,
    bodyRaw: row.body_raw ? byteaToBase64(row.body_raw) : undefined,
    queryParams: asStringRecord(row.query_params),
    ...(row.query_raw ? { queryRaw: row.query_raw } : {}),
    contentType: row.content_type ?? undefined,
    ip: row.ip,
    size: row.size,
    receivedAt: parseMillis(row.received_at),
    signatureVerified: row.signature_verified ?? null,
    signatureError: row.signature_error ?? null,
    signingProvider: row.signing_provider ?? null,
    detectedProvider: detection.detectedProvider,
    detectedEvent: detection.detectedEvent,
    kind,
    email: kind === "email" ? toEmailCapture(row.email) : null,
  };
}

/**
 * The `extracts` query parameter of the request routes: "true" asks for
 * withEmailExtracts(), "false" or no parameter does not, and anything else is
 * invalid (null).
 */
export function parseExtractsParam(value: string | null): boolean | null {
  if (value === null || value === "false") return false;
  return value === "true" ? true : null;
}

/**
 * Adds `extracts` to the emails among `records`: the codes and links the
 * dashboard's "Found in this email" shows, computed by the same function, so
 * SDKs in other languages read them instead of reimplementing the extraction.
 * Like forwarding, it honours the endpoint's "Show codes and links found in
 * emails": `extracts` is null when that is off.
 *
 * The routes add it only on `extracts=true`. Up to 20 links can make it tens
 * of kilobytes, which would break the MCP server's output budget and cost the
 * dashboard's refreshes for nothing. Extraction takes time linear in the
 * message, but text and HTML may be 256 KB each, so it yields between emails
 * instead of holding the event loop for a whole page.
 */
export async function withEmailExtracts(records: RequestRecord[]): Promise<RequestRecord[]> {
  const endpointIds = [
    ...new Set(records.filter((record) => record.kind === "email").map((r) => r.endpointId)),
  ];
  if (endpointIds.length === 0) return records;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoints")
    .select("id, show_email_extracts")
    .in("id", endpointIds);
  if (error) throw error;
  const enabled = new Set(
    (data ?? []).filter((row) => row.show_email_extracts !== false).map((row) => row.id)
  );

  const out: RequestRecord[] = [];
  for (const record of records) {
    if (record.kind !== "email") {
      out.push(record);
    } else if (!record.email || !enabled.has(record.endpointId)) {
      out.push({ ...record, extracts: null });
    } else {
      out.push({ ...record, extracts: extractFromEmail(record.email) });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return out;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  return Math.min(Math.max(1, Math.floor(limit ?? fallback)), MAX_LIST_LIMIT);
}

function encodeCursor(offset: number, cutoff: number): string {
  return Buffer.from(JSON.stringify({ offset, cutoff }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): { offset: number; cutoff: number } | null {
  if (!cursor) return null;

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      offset?: unknown;
      cutoff?: unknown;
    };

    if (
      typeof parsed.offset !== "number" ||
      !Number.isFinite(parsed.offset) ||
      parsed.offset < 0 ||
      typeof parsed.cutoff !== "number" ||
      !Number.isFinite(parsed.cutoff) ||
      parsed.cutoff < 0
    ) {
      return null;
    }

    return {
      offset: parsed.offset,
      cutoff: parsed.cutoff,
    };
  } catch {
    return null;
  }
}

async function getOwnedEndpoint(userId: string, slug: string): Promise<OwnedEndpointRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoints")
    .select("id, slug")
    .eq("user_id", userId)
    .eq("slug", slug.toLowerCase())
    .returns<OwnedEndpointRow>()
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Like getOwnedEndpoint, but also allows access if the user is a team member
 * with shared access to the endpoint. Returns the endpoint info plus the owner's
 * userId for retention lookups.
 */
async function getAccessibleEndpoint(
  userId: string,
  slug: string
): Promise<{ id: string; slug: string; ownerId: string } | null> {
  const access = await resolveEndpointAccess(userId, slug);
  if (!access) return null;
  return { id: access.endpointId, slug, ownerId: access.ownerId };
}

interface Retention {
  /** Rows received before this instant are outside the owner's window. */
  cutoff: number;
  /**
   * True on the free plan, where a request billed to a team's pooled quota was
   * paid for by that team's subscription and so outlives the 7-day personal
   * window. Mirrors the `team_id is null` carve-out in cleanup_free_user_requests().
   */
  exemptTeamBilled: boolean;
}

async function getUserRetention(userId: string): Promise<Retention> {
  const admin = createAdminClient();
  const { data: user, error } = await admin
    .from("users")
    .select("plan")
    .eq("id", userId)
    .maybeSingle<{ plan: UserPlan }>();

  if (error) {
    throw error;
  }

  const isPro = user?.plan === "pro";
  return {
    cutoff: Date.now() - (isPro ? PRO_RETENTION_MS : FREE_RETENTION_MS),
    exemptTeamBilled: !isPro,
  };
}

/**
 * PostgREST `or()` filter that keeps team-billed rows past the cutoff. It stays
 * a separate conjunct from any caller-supplied `since`/`after` bound, which must
 * keep applying to team-billed rows too.
 */
function retentionOrFilter(cutoff: number): string {
  return `team_id.not.is.null,received_at.gte.${new Date(cutoff).toISOString()}`;
}

/**
 * Requests by id with no access check, for server work that already knows
 * which rows it may read (the email forwarding worker claims them).
 */
export async function getRequestsByIds(ids: string[]): Promise<RequestRecord[]> {
  if (ids.length === 0) return [];
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("requests")
    .select(
      "id, endpoint_id, method, path, headers, body, body_raw, query_params, query_raw, content_type, ip, size, received_at, team_id, signature_verified, signature_error, signing_provider, kind, email"
    )
    .in("id", ids)
    .returns<SelectedRequestRowWithQuery[]>();
  if (error) throw error;
  return (data ?? []).map(normalizeRequest);
}

export async function getRequestByIdForUser(
  userId: string,
  requestId: string
): Promise<RequestRecord | null> {
  const admin = createAdminClient();

  // Fetch request without user_id filter — we check access via endpoint ownership or team membership
  const { data, error } = await admin
    .from("requests")
    .select(
      "id, endpoint_id, method, path, headers, body, body_raw, query_params, content_type, ip, size, received_at, team_id, signature_verified, signature_error, signing_provider, kind, email"
    )
    .eq("id", requestId)
    .returns<SelectedRequestRow>()
    .maybeSingle();

  if (error) {
    throw error;
  }

  const row = data as SelectedRequestRow | null;
  if (!row) return null;

  // Verify user has access to this endpoint (owner or team member)
  const endpointData = await admin
    .from("endpoints")
    .select("slug, user_id")
    .eq("id", row.endpoint_id)
    .maybeSingle();

  if (!endpointData.data || !endpointData.data.user_id) return null;

  const access = await resolveEndpointAccess(userId, endpointData.data.slug);
  if (!access) return null;

  const retention = await getUserRetention(access.ownerId);
  const teamBilled = row.team_id !== null;
  if (
    !(retention.exemptTeamBilled && teamBilled) &&
    parseMillis(row.received_at) < retention.cutoff
  ) {
    return null;
  }

  return normalizeRequest(row);
}

export async function listRequestsForEndpointByUser(input: {
  userId: string;
  slug: string;
  limit?: number;
  since?: number;
  /** Only HTTP requests or only emails. */
  kind?: RequestKind;
}): Promise<RequestRecord[] | null> {
  const admin = createAdminClient();
  const endpoint = await getAccessibleEndpoint(input.userId, input.slug);
  if (!endpoint) {
    return null;
  }

  const retention = await getUserRetention(endpoint.ownerId);

  const query = admin
    .from("requests")
    .select(
      "id, endpoint_id, method, path, headers, body, body_raw, query_params, content_type, ip, size, received_at, team_id, signature_verified, signature_error, signing_provider, kind, email"
    )
    .eq("endpoint_id", endpoint.id);

  if (retention.exemptTeamBilled) {
    query.or(retentionOrFilter(retention.cutoff));
    if (input.since !== undefined) {
      query.gte("received_at", new Date(input.since).toISOString());
    }
  } else {
    const floor =
      input.since === undefined ? retention.cutoff : Math.max(input.since, retention.cutoff);
    query.gte("received_at", new Date(floor).toISOString());
  }
  if (input.kind) {
    query.eq("kind", input.kind);
  }

  const { data, error } = await query
    .order("received_at", { ascending: false })
    .limit(clampLimit(input.limit, 50))
    .returns<SelectedRequestRow[]>();

  if (error) {
    throw error;
  }

  return (data ?? []).map(normalizeRequest);
}

export async function listNewRequestsForEndpointByUser(input: {
  userId: string;
  slug: string;
  after: number;
  limit?: number;
}): Promise<RequestRecord[] | null> {
  const page = await listRequestsAfterCursorForEndpointByUser(input);
  return page && page.records;
}

/** Position of a request in (received_at, id) order, at full database precision. */
export interface RequestCursor {
  receivedAt: string;
  id: string;
}

/**
 * Requests after `cursor` in (received_at, id) order, or after the `after`
 * millisecond timestamp when there is no cursor yet. `receivedAt` on the
 * records is truncated to milliseconds, so paging by it alone would skip rows
 * that share a millisecond; the returned cursor keeps the database value.
 */
export async function listRequestsAfterCursorForEndpointByUser(input: {
  userId: string;
  slug: string;
  after: number;
  cursor?: RequestCursor | null;
  limit?: number;
}): Promise<{ records: RequestRecord[]; cursor: RequestCursor | null } | null> {
  const admin = createAdminClient();
  const endpoint = await getAccessibleEndpoint(input.userId, input.slug);
  if (!endpoint) {
    return null;
  }

  const retention = await getUserRetention(endpoint.ownerId);

  const query = admin
    .from("requests")
    .select(
      "id, endpoint_id, method, path, headers, body, body_raw, query_params, content_type, ip, size, received_at, team_id, signature_verified, signature_error, signing_provider, kind, email"
    )
    .eq("endpoint_id", endpoint.id);

  if (input.cursor) {
    const at = `"${input.cursor.receivedAt}"`;
    query.or(`received_at.gt.${at},and(received_at.eq.${at},id.gt.${input.cursor.id})`);
  } else {
    query.gt("received_at", new Date(input.after).toISOString());
  }

  if (retention.exemptTeamBilled) {
    query.or(retentionOrFilter(retention.cutoff));
  } else {
    query.gte("received_at", new Date(retention.cutoff).toISOString());
  }

  const { data, error } = await query
    .order("received_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(clampLimit(input.limit, 100))
    .returns<SelectedRequestRow[]>();

  if (error) {
    throw error;
  }

  const rows = data ?? [];
  const last = rows[rows.length - 1];
  return {
    records: rows.map(normalizeRequest),
    cursor: last ? { receivedAt: last.received_at, id: last.id } : (input.cursor ?? null),
  };
}

export async function listPaginatedRequestsForEndpointByUser(input: {
  userId: string;
  slug: string;
  limit?: number;
  cursor?: string;
  /** Only HTTP requests or only emails; pass the same value for every page. */
  kind?: RequestKind;
}): Promise<PaginatedRequestPage | null> {
  const admin = createAdminClient();
  const endpoint = await getAccessibleEndpoint(input.userId, input.slug);
  if (!endpoint) {
    return null;
  }

  const decoded = decodeCursor(input.cursor);
  if (input.cursor && !decoded) {
    throw new Error("invalid_cursor");
  }

  const limit = clampLimit(input.limit, 50);
  const retention = await getUserRetention(endpoint.ownerId);
  // The cursor pins the cutoff so pages stay stable as the window slides.
  const cutoff = decoded?.cutoff ?? retention.cutoff;
  const offset = decoded?.offset ?? 0;

  const query = admin
    .from("requests")
    .select(
      "id, endpoint_id, method, path, headers, body, body_raw, query_params, content_type, ip, size, received_at, team_id, signature_verified, signature_error, signing_provider, kind, email"
    )
    .eq("endpoint_id", endpoint.id);

  if (retention.exemptTeamBilled) {
    query.or(retentionOrFilter(cutoff));
  } else {
    query.gte("received_at", new Date(cutoff).toISOString());
  }
  if (input.kind) {
    query.eq("kind", input.kind);
  }

  const { data, error } = await query
    .order("received_at", { ascending: false })
    .range(offset, offset + limit)
    .returns<SelectedRequestRow[]>();

  if (error) {
    throw error;
  }

  const rows = data ?? [];
  const items = rows.slice(0, limit).map(normalizeRequest);
  const hasMore = rows.length > limit;

  return {
    items,
    cursor: hasMore ? encodeCursor(offset + limit, cutoff) : undefined,
    hasMore,
  };
}

export async function clearRequestsForEndpointByUser(input: {
  userId: string;
  slug: string;
  before?: number;
}): Promise<ClearRequestsResult | null> {
  const admin = createAdminClient();
  const endpoint = await getOwnedEndpoint(input.userId, input.slug);
  if (!endpoint) {
    return null;
  }

  const countQuery = admin
    .from("requests")
    .select("id", { count: "exact", head: true })
    .eq("endpoint_id", endpoint.id);

  if (input.before !== undefined) {
    countQuery.lt("received_at", new Date(input.before).toISOString());
  }

  const { count, error: countError } = await countQuery;
  if (countError) {
    throw countError;
  }

  const deleteQuery = admin.from("requests").delete().eq("endpoint_id", endpoint.id);
  if (input.before !== undefined) {
    deleteQuery.lt("received_at", new Date(input.before).toISOString());
  }

  const { error: deleteError } = await deleteQuery;
  if (deleteError) {
    throw deleteError;
  }

  return {
    deleted: count ?? 0,
    complete: true,
  };
}

/**
 * Requests captured by an agent sandbox endpoint, newest first. The caller
 * has already matched the endpoint to the bearer's registration. Sandbox
 * requests live as long as the endpoint (at most a day), so no retention
 * cutoff applies.
 */
export async function listRequestsForSandboxEndpoint(
  endpointId: string,
  input: { since?: number; limit?: number; maxLimit: number }
): Promise<RequestRecord[]> {
  const admin = createAdminClient();
  const query = admin
    .from("requests")
    .select(
      "id, endpoint_id, method, path, headers, body, body_raw, query_params, content_type, ip, size, received_at, team_id, signature_verified, signature_error, signing_provider, kind, email"
    )
    .eq("endpoint_id", endpointId);
  if (input.since !== undefined) {
    query.gte("received_at", new Date(input.since).toISOString());
  }
  const { data, error } = await query
    .order("received_at", { ascending: false })
    .limit(Math.min(clampLimit(input.limit, input.maxLimit), input.maxLimit))
    .returns<SelectedRequestRow[]>();
  if (error) throw error;
  return (data ?? []).map(normalizeRequest);
}

/** One request, only when one of the registration's sandbox endpoints captured it. */
export async function getSandboxRequest(
  registrationId: string,
  requestId: string
): Promise<RequestRecord | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("requests")
    .select(
      "id, endpoint_id, method, path, headers, body, body_raw, query_params, content_type, ip, size, received_at, team_id, signature_verified, signature_error, signing_provider, kind, email"
    )
    .eq("id", requestId)
    .returns<SelectedRequestRow>()
    .maybeSingle();
  if (error) throw error;
  const row = data as SelectedRequestRow | null;
  if (!row) return null;

  const { data: endpoint, error: endpointError } = await admin
    .from("endpoints")
    .select("id")
    .eq("id", row.endpoint_id)
    .eq("agent_registration_id", registrationId)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (endpointError) throw endpointError;
  return endpoint ? normalizeRequest(row) : null;
}
