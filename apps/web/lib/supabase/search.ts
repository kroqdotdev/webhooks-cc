import { createAdminClient } from "./admin";
import type { Database, Json } from "./database";
import { deriveWebhookDetection } from "@/lib/webhook-detection";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_OFFSET = 10_000;

type UserPlan = Database["public"]["Tables"]["users"]["Row"]["plan"];
type SearchRpcRow = Database["public"]["Functions"]["search_requests"]["Returns"][number];

export interface SearchRequestRecord {
  id: string;
  slug: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  queryParams: Record<string, string>;
  contentType?: string;
  ip: string;
  size: number;
  receivedAt: number;
  detectedProvider?: string | null;
  detectedEvent?: string | null;
}

export interface SearchRequestsInput {
  userId: string;
  plan?: UserPlan;
  slug?: string;
  method?: string;
  q?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

export interface CountSearchRequestsInput {
  userId: string;
  plan?: UserPlan;
  slug?: string;
  method?: string;
  q?: string;
  from?: number;
  to?: number;
}

function asStringRecord(value: Json): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => typeof item === "string")
  ) as Record<string, string>;
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  return Math.min(Math.max(0, Math.floor(offset)), MAX_OFFSET);
}

function normalizeOrder(order: "asc" | "desc" | undefined): "asc" | "desc" {
  return order === "asc" ? "asc" : "desc";
}

function normalizeTimestamp(value: number | undefined): number | null {
  if (value === undefined) return null;
  return Number.isFinite(value) ? Math.floor(value) : null;
}

function normalizeSearchRow(row: SearchRpcRow): SearchRequestRecord {
  const headers = asStringRecord(row.headers);
  const body = row.body ?? undefined;
  const detection = deriveWebhookDetection({
    headers,
    body,
    contentType: row.content_type ?? undefined,
  });

  return {
    id: row.id,
    slug: row.slug,
    method: row.method,
    path: row.path,
    headers,
    body,
    queryParams: asStringRecord(row.query_params),
    contentType: row.content_type ?? undefined,
    ip: row.ip,
    size: row.size,
    receivedAt: row.received_at,
    detectedProvider: detection.detectedProvider,
    detectedEvent: detection.detectedEvent,
  };
}

async function resolvePlan(userId: string, plan: UserPlan | undefined): Promise<UserPlan> {
  if (plan === "free" || plan === "pro") {
    return plan;
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("users")
    .select("plan")
    .eq("id", userId)
    .maybeSingle<{ plan: UserPlan }>();

  if (error) {
    throw error;
  }

  return data?.plan ?? "free";
}

export async function searchRequestsForUser(
  input: SearchRequestsInput
): Promise<SearchRequestRecord[]> {
  const admin = createAdminClient();
  const plan = await resolvePlan(input.userId, input.plan);

  const { data, error } = await admin.rpc("search_requests", {
    p_user_id: input.userId,
    p_plan: plan,
    p_slug: normalizeOptionalString(input.slug),
    p_method: normalizeOptionalString(input.method),
    p_q: normalizeOptionalString(input.q),
    p_from_ms: normalizeTimestamp(input.from),
    p_to_ms: normalizeTimestamp(input.to),
    p_limit: clampLimit(input.limit),
    p_offset: clampOffset(input.offset),
    p_order: normalizeOrder(input.order),
  });

  if (error) {
    throw error;
  }

  return (data ?? []).map(normalizeSearchRow);
}

export async function countSearchRequestsForUser(input: CountSearchRequestsInput): Promise<number> {
  const admin = createAdminClient();
  const plan = await resolvePlan(input.userId, input.plan);

  const { data, error } = await admin.rpc("search_requests_count", {
    p_user_id: input.userId,
    p_plan: plan,
    p_slug: normalizeOptionalString(input.slug),
    p_method: normalizeOptionalString(input.method),
    p_q: normalizeOptionalString(input.q),
    p_from_ms: normalizeTimestamp(input.from),
    p_to_ms: normalizeTimestamp(input.to),
  });

  if (error) {
    throw error;
  }

  if (typeof data === "number") {
    return data;
  }

  if (typeof data === "string") {
    const parsed = Number(data);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}
