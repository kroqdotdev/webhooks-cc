import { createAdminClient } from "./admin";
import type { Database, Json } from "./database";
import { resolveEndpointAccess } from "./teams";
import { deriveWebhookDetection } from "@/lib/webhook-detection";

const FREE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRO_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
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
> & {
  signature_verified?: boolean | null;
  signature_error?: string | null;
  signing_provider?: string | null;
};
type OwnedEndpointRow = Pick<Database["public"]["Tables"]["endpoints"]["Row"], "id" | "slug">;
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
  contentType?: string;
  ip: string;
  size: number;
  receivedAt: number;
  signatureVerified?: boolean | null;
  signatureError?: string | null;
  signingProvider?: string | null;
  detectedProvider?: string | null;
  detectedEvent?: string | null;
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

function normalizeRequest(row: SelectedRequestRow): RequestRecord {
  const headers = asStringRecord(row.headers);
  const body = row.body ?? undefined;
  const detection = deriveWebhookDetection({
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
    contentType: row.content_type ?? undefined,
    ip: row.ip,
    size: row.size,
    receivedAt: parseMillis(row.received_at),
    signatureVerified: row.signature_verified ?? null,
    signatureError: row.signature_error ?? null,
    signingProvider: row.signing_provider ?? null,
    detectedProvider: detection.detectedProvider,
    detectedEvent: detection.detectedEvent,
  };
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

export async function getRequestByIdForUser(
  userId: string,
  requestId: string
): Promise<RequestRecord | null> {
  const admin = createAdminClient();

  // Fetch request without user_id filter — we check access via endpoint ownership or team membership
  const { data, error } = await admin
    .from("requests")
    .select(
      "id, endpoint_id, method, path, headers, body, body_raw, query_params, content_type, ip, size, received_at, team_id, signature_verified, signature_error, signing_provider"
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
      "id, endpoint_id, method, path, headers, body, body_raw, query_params, content_type, ip, size, received_at, team_id, signature_verified, signature_error, signing_provider"
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
  const admin = createAdminClient();
  const endpoint = await getAccessibleEndpoint(input.userId, input.slug);
  if (!endpoint) {
    return null;
  }

  const retention = await getUserRetention(endpoint.ownerId);

  const query = admin
    .from("requests")
    .select(
      "id, endpoint_id, method, path, headers, body, body_raw, query_params, content_type, ip, size, received_at, team_id, signature_verified, signature_error, signing_provider"
    )
    .eq("endpoint_id", endpoint.id)
    .gt("received_at", new Date(input.after).toISOString());

  if (retention.exemptTeamBilled) {
    query.or(retentionOrFilter(retention.cutoff));
  } else {
    query.gte("received_at", new Date(retention.cutoff).toISOString());
  }

  const { data, error } = await query
    .order("received_at", { ascending: true })
    .limit(clampLimit(input.limit, 100))
    .returns<SelectedRequestRow[]>();

  if (error) {
    throw error;
  }

  return (data ?? []).map(normalizeRequest);
}

export async function listPaginatedRequestsForEndpointByUser(input: {
  userId: string;
  slug: string;
  limit?: number;
  cursor?: string;
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
      "id, endpoint_id, method, path, headers, body, body_raw, query_params, content_type, ip, size, received_at, team_id, signature_verified, signature_error, signing_provider"
    )
    .eq("endpoint_id", endpoint.id);

  if (retention.exemptTeamBilled) {
    query.or(retentionOrFilter(cutoff));
  } else {
    query.gte("received_at", new Date(cutoff).toISOString());
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
