import { createHmac, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "./admin";
import type { Database, Json } from "./database";
import { deriveWebhookDetection } from "@/lib/webhook-detection";
import { toEmailCapture, type EmailCapture } from "@/lib/email-capture";
import { byteaToBase64 } from "./requests";
import { isUserPlan } from "@/lib/entitlements";

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
  /** Base64 of the exact bytes, when the body was not valid UTF-8. */
  bodyRaw?: string;
  queryParams: Record<string, string>;
  contentType?: string;
  ip: string;
  size: number;
  receivedAt: number;
  detectedProvider?: string | null;
  detectedEvent?: string | null;
  kind: "http" | "email";
  email?: EmailCapture | null;
}

export type RequestKind = "http" | "email";

export function isRequestKind(value: unknown): value is RequestKind {
  return value === "http" || value === "email";
}

export interface SearchRequestsInput {
  userId: string;
  plan?: UserPlan;
  slug?: string;
  method?: string;
  kind?: RequestKind;
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
  kind?: RequestKind;
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
  const kind = row.kind === "email" ? "email" : "http";
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
    slug: row.slug,
    method: row.method,
    path: row.path,
    headers,
    body,
    bodyRaw: row.body_raw ? byteaToBase64(row.body_raw) : undefined,
    queryParams: asStringRecord(row.query_params),
    contentType: row.content_type ?? undefined,
    ip: row.ip,
    size: row.size,
    receivedAt: row.received_at,
    detectedProvider: detection.detectedProvider,
    detectedEvent: detection.detectedEvent,
    kind,
    email: kind === "email" ? toEmailCapture(row.email) : null,
  };
}

async function resolvePlan(userId: string, plan: UserPlan | undefined): Promise<UserPlan> {
  if (isUserPlan(plan)) {
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

/**
 * How long one search may read rows before it answers with what it found,
 * for callers that page with the cursor (`paged=true`).
 */
export const SEARCH_BUDGET_MS = 2_000;

/**
 * The budget for callers that do not say they page: the SDKs, CLI, MCP
 * server and integrations released before bounded search read one answer
 * and stop, so they get longer to find what they asked for. It stays well
 * inside their 30 s request timeouts.
 */
export const LEGACY_SEARCH_BUDGET_MS = 10_000;

/** A cursor this server did not issue, or one for the other order. */
export class InvalidSearchCursorError extends Error {
  constructor() {
    super("invalid_cursor");
    this.name = "InvalidSearchCursorError";
  }
}

export interface SearchPage {
  requests: SearchRequestRecord[];
  /** True when the whole range in scope was read. */
  complete: boolean;
  /**
   * How far the search read, as a time in ms: where it stopped, or the end
   * of the range when complete (null when that end is open).
   */
  searchedUntil: number | null;
  /** Pass back to continue where this page stopped; null when complete. */
  cursor: string | null;
  /** Slices read, for telemetry. */
  slices: number;
}

export interface SearchCount {
  count: number;
  /** False when the time budget ran out first: `count` is then a lower bound. */
  exact: boolean;
  searchedUntil: number | null;
  cursor: string | null;
  slices: number;
}

interface PageRpcResult {
  requests?: SearchRpcRow[] | null;
  complete?: boolean;
  searched_until?: number | string | null;
  cursor?: string | null;
  slices?: number;
  cancelled?: boolean;
}

interface CountRpcResult {
  count?: number | string;
  exact?: boolean;
  searched_until?: number | string | null;
  cursor?: string | null;
  slices?: number;
  cancelled?: boolean;
}

// The database's cursor ("d|<time>|<id>[|<offset left>]") travels
// base64url-encoded with a MAC over it, so clients treat it as opaque, it
// survives a query string untouched, and only a cursor this server issued is
// taken (a made-up one could otherwise spend the larger continuation
// allowance on first pages). It is a position only: what a search may see
// always comes from the caller's account and parameters, so a cursor handed
// to another account reaches nothing new.
function cursorMac(cursor: string): Buffer {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  return createHmac("sha256", key).update(`search-cursor:v1:${cursor}`).digest().subarray(0, 16);
}

function encodeCursor(cursor: string | null | undefined): string | null {
  if (!cursor) return null;
  return `${Buffer.from(cursor, "utf8").toString("base64url")}.${cursorMac(cursor).toString("base64url")}`;
}

function decodeCursor(cursor: string | undefined): string | null {
  const trimmed = cursor?.trim();
  if (!trimmed) return null;
  const match = /^([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{22})$/.exec(trimmed);
  if (!match) throw new InvalidSearchCursorError();
  const decoded = Buffer.from(match[1], "base64url").toString("utf8");
  const given = Buffer.from(match[2], "base64url");
  const expected = cursorMac(decoded);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new InvalidSearchCursorError();
  }
  if (!/^[ad]\|[^|]+\|[0-9a-f-]{36}(\|\d{1,5})?$/.test(decoded)) {
    throw new InvalidSearchCursorError();
  }
  return decoded;
}

function toMs(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isInvalidCursorError(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  return e?.code === "22023" && e?.message === "invalid cursor";
}

/** What every search call may carry besides its filters. */
export interface SearchRunOptions {
  cursor?: string;
  budgetMs?: number;
  /**
   * A token cancelRequestSearch() can name to stop the search after the
   * slice it is in (the caller went away).
   */
  cancelToken?: string;
}

interface PageRpcArgs extends SearchRequestsInput, SearchRunOptions {
  count: boolean;
}

async function callSearchPage(input: PageRpcArgs): Promise<unknown> {
  const admin = createAdminClient();
  const plan = await resolvePlan(input.userId, input.plan);
  const cursor = decodeCursor(input.cursor);

  // No abort signal reaches the call: PostgREST does not cancel a running
  // statement when the client goes away. The search stops at its budget, or
  // earlier when cancelRequestSearch() names its token, and the caller's
  // search slot stays held until it has.
  const { data, error } = await admin.rpc("search_requests_page", {
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
    p_kind: input.kind ?? null,
    p_cursor: cursor,
    p_budget_ms: Math.max(1, Math.floor(input.budgetMs ?? SEARCH_BUDGET_MS)),
    p_count: input.count,
    p_cancel: input.cancelToken ?? null,
  });
  if (error) {
    if (isInvalidCursorError(error)) throw new InvalidSearchCursorError();
    throw error;
  }
  return data;
}

/**
 * One page of a search: the newest (or oldest) matches the time budget
 * found, and where it stopped. Continue with `cursor` until `complete`.
 */
export async function searchRequestPage(
  input: SearchRequestsInput & SearchRunOptions
): Promise<SearchPage> {
  const data = (await callSearchPage({ ...input, count: false })) as PageRpcResult | null;
  return {
    requests: (data?.requests ?? []).map(normalizeSearchRow),
    complete: data?.complete === true,
    searchedUntil: toMs(data?.searched_until),
    cursor: encodeCursor(data?.cursor),
    slices: data?.slices ?? 0,
  };
}

/**
 * Counts what a search matches. A count without a term or a method is an
 * exact index count; any other covers what the time budget reached and
 * says whether that was all.
 */
export async function countSearchRequests(
  input: CountSearchRequestsInput & SearchRunOptions
): Promise<SearchCount> {
  const data = (await callSearchPage({ ...input, count: true })) as CountRpcResult | null;
  return {
    count: toMs(data?.count) ?? 0,
    exact: data?.exact === true,
    searchedUntil: toMs(data?.searched_until),
    cursor: encodeCursor(data?.cursor),
    slices: data?.slices ?? 0,
  };
}

/**
 * Stops the search running with this token after the slice it is in. Best
 * effort: a search that already finished is unaffected.
 */
export async function cancelRequestSearch(token: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.rpc("cancel_request_search", { p_token: token });
  if (error) throw error;
}

/** The first page's requests (kept for callers that only want rows). */
export async function searchRequestsForUser(
  input: SearchRequestsInput
): Promise<SearchRequestRecord[]> {
  return (await searchRequestPage(input)).requests;
}

/** The count alone (kept for callers that only want the number). */
export async function countSearchRequestsForUser(input: CountSearchRequestsInput): Promise<number> {
  return (await countSearchRequests(input)).count;
}
