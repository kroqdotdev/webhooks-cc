"use client";

import type { Database, Json } from "@/lib/supabase/database";
import type { Request } from "@/types/request";

type EndpointRow = Database["public"]["Tables"]["endpoints"]["Row"];
type RequestRow = Database["public"]["Tables"]["requests"]["Row"];

export interface GuestEndpointRecord {
  id: string;
  slug: string;
  isEphemeral?: boolean;
  expiresAt?: number;
  requestCount: number;
}

function parseMillis(timestamp: string | null): number | undefined {
  if (!timestamp) return undefined;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function asStringRecord(value: Json): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => typeof item === "string")
  ) as Record<string, string>;
}

export function normalizeGuestEndpoint(
  row: Pick<EndpointRow, "id" | "slug" | "is_ephemeral" | "expires_at" | "request_count">
): GuestEndpointRecord {
  return {
    id: row.id,
    slug: row.slug,
    isEphemeral: row.is_ephemeral || undefined,
    expiresAt: parseMillis(row.expires_at),
    requestCount: row.request_count,
  };
}

function normalizeRequest(row: Pick<RequestRow, "id" | "endpoint_id" | "method" | "path" | "headers" | "body" | "query_params" | "content_type" | "ip" | "size" | "received_at">): Request {
  const receivedAt = parseMillis(row.received_at) ?? Date.now();
  return {
    _id: row.id,
    _creationTime: receivedAt,
    endpointId: row.endpoint_id,
    method: row.method,
    path: row.path,
    headers: asStringRecord(row.headers),
    body: row.body ?? undefined,
    queryParams: asStringRecord(row.query_params),
    contentType: row.content_type ?? undefined,
    ip: row.ip,
    size: row.size,
    receivedAt,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | { error?: string }
    | null;

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }

  return data as T;
}

export async function createGuestDashboardEndpoint(): Promise<GuestEndpointRecord> {
  const response = await fetch("/api/go/endpoint", {
    method: "POST",
  });
  return readJson<GuestEndpointRecord>(response);
}

export async function fetchGuestDashboardEndpoint(
  slug: string
): Promise<GuestEndpointRecord | null> {
  const response = await fetch(`/api/go/endpoint/${encodeURIComponent(slug)}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to fetch endpoint (${response.status})`);
  }
  return response.json() as Promise<GuestEndpointRecord>;
}

export async function fetchGuestDashboardRequests(
  slug: string,
  limit: number
): Promise<Request[]> {
  const response = await fetch(
    `/api/go/endpoint/${encodeURIComponent(slug)}/requests?limit=${limit}`
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch requests (${response.status})`);
  }
  const rows = (await response.json()) as Array<
    Pick<
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
    >
  >;
  return rows.map(normalizeRequest);
}
