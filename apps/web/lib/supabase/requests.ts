import { createAdminClient } from "./admin";
import type { Database, Json } from "./database";
import { resolveEndpointAccess } from "./teams";

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
  | "query_params"
  | "content_type"
  | "ip"
  | "size"
  | "received_at"
>;
type OwnedEndpointRow = Pick<Database["public"]["Tables"]["endpoints"]["Row"], "id" | "slug">;
type UserPlan = Database["public"]["Tables"]["users"]["Row"]["plan"];

export interface RequestRecord {
  id: string;
  endpointId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  queryParams: Record<string, string>;
  contentType?: string;
  ip: string;
  size: number;
  receivedAt: number;
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

function normalizeRequest(row: SelectedRequestRow): RequestRecord {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    method: row.method,
    path: row.path,
    headers: asStringRecord(row.headers),
    body: row.body ?? undefined,
    queryParams: asStringRecord(row.query_params),
    contentType: row.content_type ?? undefined,
    ip: row.ip,
    size: row.size,
    receivedAt: parseMillis(row.received_at),
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

async function getUserCutoff(userId: string): Promise<number> {
  const admin = createAdminClient();
  const { data: user, error } = await admin
    .from("users")
    .select("plan")
    .eq("id", userId)
    .maybeSingle<{ plan: UserPlan }>();

  if (error) {
    throw error;
  }

  const retentionMs = user?.plan === "pro" ? PRO_RETENTION_MS : FREE_RETENTION_MS;
  return Date.now() - retentionMs;
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
      "id, endpoint_id, method, path, headers, body, query_params, content_type, ip, size, received_at"
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

  const cutoff = await getUserCutoff(access.ownerId);
  if (parseMillis(row.received_at) < cutoff) {
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

  const cutoff = await getUserCutoff(endpoint.ownerId);
  const floor = input.since === undefined ? cutoff : Math.max(input.since, cutoff);

  const { data, error } = await admin
    .from("requests")
    .select(
      "id, endpoint_id, method, path, headers, body, query_params, content_type, ip, size, received_at"
    )
    .eq("endpoint_id", endpoint.id)
    .gte("received_at", new Date(floor).toISOString())
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

  const cutoff = await getUserCutoff(endpoint.ownerId);
  const floor = Math.max(input.after, cutoff);

  const { data, error } = await admin
    .from("requests")
    .select(
      "id, endpoint_id, method, path, headers, body, query_params, content_type, ip, size, received_at"
    )
    .eq("endpoint_id", endpoint.id)
    .gt("received_at", new Date(floor).toISOString())
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
  const cutoff = decoded?.cutoff ?? (await getUserCutoff(endpoint.ownerId));
  const offset = decoded?.offset ?? 0;

  const { data, error } = await admin
    .from("requests")
    .select(
      "id, endpoint_id, method, path, headers, body, query_params, content_type, ip, size, received_at"
    )
    .eq("endpoint_id", endpoint.id)
    .gte("received_at", new Date(cutoff).toISOString())
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
