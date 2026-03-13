"use client";

import type { ClickHouseRequest, Request } from "@/types/request";

export interface DashboardEndpoint {
  id: string;
  slug: string;
  name?: string;
  url?: string;
  mockResponse?: {
    status: number;
    body: string;
    headers: Record<string, string>;
  };
  isEphemeral?: boolean;
  expiresAt?: number;
  createdAt: number;
}

const ENDPOINTS_CHANGED_EVENT = "dashboard:endpoints-changed";

function withAuthHeaders(accessToken: string, init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return {
    ...init,
    headers,
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

function toDashboardRequest(record: {
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
}): Request {
  return {
    _id: record.id,
    _creationTime: record.receivedAt,
    endpointId: record.endpointId,
    method: record.method,
    path: record.path,
    headers: record.headers,
    body: record.body,
    queryParams: record.queryParams,
    contentType: record.contentType,
    ip: record.ip,
    size: record.size,
    receivedAt: record.receivedAt,
  };
}

export async function fetchDashboardEndpoints(accessToken: string): Promise<DashboardEndpoint[]> {
  const response = await fetch("/api/endpoints", withAuthHeaders(accessToken));
  return readJson<DashboardEndpoint[]>(response);
}

export async function fetchDashboardEndpoint(
  accessToken: string,
  slug: string
): Promise<DashboardEndpoint> {
  const response = await fetch(
    `/api/endpoints/${encodeURIComponent(slug)}`,
    withAuthHeaders(accessToken)
  );
  return readJson<DashboardEndpoint>(response);
}

export async function createDashboardEndpoint(
  accessToken: string,
  body: Record<string, unknown>
): Promise<DashboardEndpoint> {
  const response = await fetch(
    "/api/endpoints",
    withAuthHeaders(accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return readJson<DashboardEndpoint>(response);
}

export async function updateDashboardEndpoint(
  accessToken: string,
  slug: string,
  body: Record<string, unknown>
): Promise<DashboardEndpoint> {
  const response = await fetch(
    `/api/endpoints/${encodeURIComponent(slug)}`,
    withAuthHeaders(accessToken, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return readJson<DashboardEndpoint>(response);
}

export async function deleteDashboardEndpoint(accessToken: string, slug: string): Promise<void> {
  const response = await fetch(
    `/api/endpoints/${encodeURIComponent(slug)}`,
    withAuthHeaders(accessToken, {
      method: "DELETE",
    })
  );

  if (!response.ok) {
    await readJson(response);
  }
}

export async function fetchDashboardRequests(
  accessToken: string,
  slug: string,
  limit: number = 50
): Promise<Request[]> {
  const response = await fetch(
    `/api/endpoints/${encodeURIComponent(slug)}/requests?limit=${limit}`,
    withAuthHeaders(accessToken)
  );
  const records = await readJson<
    Array<{
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
    }>
  >(response);

  return records.map(toDashboardRequest);
}

export async function fetchDashboardSearch(
  accessToken: string,
  params: Record<string, string>
): Promise<ClickHouseRequest[]> {
  const url = new URL("/api/search/requests", window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), withAuthHeaders(accessToken));
  return readJson<ClickHouseRequest[]>(response);
}

export async function fetchDashboardSearchCount(
  accessToken: string,
  params: Record<string, string>
): Promise<number> {
  const url = new URL("/api/search/requests/count", window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), withAuthHeaders(accessToken));
  const data = await readJson<{ count: number }>(response);
  return data.count;
}

export function emitDashboardEndpointsChanged() {
  window.dispatchEvent(new Event(ENDPOINTS_CHANGED_EVENT));
}

export function subscribeDashboardEndpointsChanged(callback: () => void) {
  window.addEventListener(ENDPOINTS_CHANGED_EVENT, callback);
  return () => window.removeEventListener(ENDPOINTS_CHANGED_EVENT, callback);
}
