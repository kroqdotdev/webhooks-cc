"use client";

import type { EmailCapture } from "@/lib/email-capture";
import type { ClickHouseRequest, Request } from "@/types/request";

export interface ResponseRuleCondition {
  field: "method" | "path" | "header" | "body_contains" | "body_path" | "query";
  op: "eq" | "contains" | "starts_with" | "matches" | "exists";
  value?: string;
  name?: string;
  path?: string;
}

export interface ResponseRule {
  id?: string;
  name?: string;
  enabled?: boolean;
  logic?: "and" | "or";
  conditions: ResponseRuleCondition[];
  response: {
    status: number;
    body: string;
    headers: Record<string, string>;
    delay?: number;
  };
}

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
  responseRules?: ResponseRule[];
  notificationUrl?: string | null;
  isEphemeral?: boolean;
  expiresAt?: number;
  createdAt: number;
  signingProvider?: string | null;
  hasSigningSecret?: boolean;
  signingHeader?: string | null;
  /** Address that delivers email here; null for endpoints without an owner. */
  emailAddress?: string | null;
  /** Show codes and links found in captured emails. */
  showEmailExtracts?: boolean;
  /** Forward captured requests and emails to forwardUrl (lib/forwarding). */
  forwardEnabled?: boolean;
  /** Owner only. */
  forwardUrl?: string | null;
  hasForwardSecret?: boolean;
  /** Which captured requests are forwarded. */
  forwardHttp?: boolean;
  forwardEmail?: boolean;
  /** "auto" picks from the URL. */
  forwardFormat?: ForwardFormatSetting;
  forwardAppendPath?: boolean;
  /** 0 (never), 3600 or 86400. */
  forwardRetrySeconds?: number;
  forwardKeepOrder?: boolean;
  /** Owner only: names with masked values. */
  forwardHeaders?: { name: string; value: string }[];
  /** The JSON body field that holds when the sender sent the request. */
  forwardSentField?: string | null;
}

export type ForwardFormatSetting = "auto" | "as_received" | "json" | "chat";
export type DeliveryFormat = "as_received" | "json" | "chat";
export type DeliveryStatus = "pending" | "succeeded" | "failed";

export interface TeamEndpointShare {
  teamId: string;
  teamName: string;
}

export interface DashboardEndpointWithSharing extends DashboardEndpoint {
  sharedWith?: TeamEndpointShare[];
  fromTeam?: { teamId: string; teamName: string };
  fromTeams?: { teamId: string; teamName: string }[];
}

export interface DashboardEndpointsResponse {
  owned: DashboardEndpointWithSharing[];
  shared: DashboardEndpointWithSharing[];
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
    (T & { error?: string }) | { error?: string } | null;

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
  kind?: "http" | "email";
  email?: EmailCapture | null;
}): Request {
  return {
    _id: record.id,
    _creationTime: record.receivedAt,
    endpointId: record.endpointId,
    method: record.method,
    path: record.path,
    headers: record.headers,
    body: record.body,
    bodyRaw: record.bodyRaw,
    queryParams: record.queryParams,
    contentType: record.contentType,
    ip: record.ip,
    size: record.size,
    receivedAt: record.receivedAt,
    signatureVerified: record.signatureVerified ?? null,
    signatureError: record.signatureError ?? null,
    signingProvider: record.signingProvider ?? null,
    detectedProvider: record.detectedProvider ?? null,
    detectedEvent: record.detectedEvent ?? null,
    kind: record.kind ?? "http",
    email: record.email ?? null,
  };
}

/** Delivers a sample email to the endpoint (see app/api/send-test-email). */
export async function sendTestEmail(
  accessToken: string,
  slug: string
): Promise<{ status: "captured"; requestId: string | null }> {
  const response = await fetch(
    "/api/send-test-email",
    withAuthHeaders(accessToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    })
  );
  return readJson<{ status: "captured"; requestId: string | null }>(response);
}

export interface DeliveryAttempt {
  /** When the result was recorded: the end of the try. It started durationMs earlier. */
  attemptedAt: number;
  status: number | null;
  durationMs: number;
  error: string | null;
  responseExcerpt: string | null;
}

/** One forwarded copy of a captured request, with its tries (newest first). */
export interface RequestDelivery {
  id: string;
  requestId: string;
  kind: "http" | "email";
  status: DeliveryStatus;
  attempts: number;
  createdAt: number;
  finishedAt: number | null;
  nextAttemptAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  /** Recorded with the first try; null while queued. */
  format: DeliveryFormat | null;
  /** Host and path (host only for chat webhooks and for team members); null while queued. */
  target: string | null;
  /** The sender's own timestamp and where it was read. */
  senderAt: number | null;
  senderSource: string | null;
  attemptLog: DeliveryAttempt[];
}

/** @deprecated Use RequestDelivery: deliveries carry HTTP requests too. */
export type EmailDelivery = RequestDelivery;

/** One row of an endpoint's delivery log. */
export interface LogDelivery {
  id: string;
  requestId: string;
  kind: "http" | "email";
  status: DeliveryStatus;
  attempts: number;
  createdAt: number;
  finishedAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  subject: string | null;
  method: string | null;
  path: string | null;
  receivedAt: number | null;
  nextAttemptAt: number | null;
  format: DeliveryFormat | null;
  senderAt: number | null;
  senderSource: string | null;
  /** Pass as `before` for older rows. */
  cursor: string;
}

export interface DeliverySummary {
  last24h: { delivered: number; failed: number };
  /** Queued or retrying now. */
  pending: number;
  /** Among the deliveries still kept. */
  failed: number;
  total: number;
}

export type DeliveryLogFilter = "all" | "pending" | "failed";

export interface ForwardTestResult {
  status: number | null;
  durationMs: number;
  excerpt: string | null;
  error: string | null;
  delivered: boolean;
  /** Nothing had arrived yet, so a sample was sent. */
  sample: boolean;
  kind: "http" | "email";
  format: DeliveryFormat;
  /** The URL the test went to, path appended where it applies. */
  url: string;
  target: string | null;
  request: { method: string; path: string; subject: string | null; receivedAt: number };
  sender: { at: number; source: string; wholeSeconds: boolean } | null;
}

const endpointPath = (slug: string) => `/api/endpoints/${encodeURIComponent(slug)}`;

export async function fetchForwardSecret(accessToken: string, slug: string): Promise<string> {
  const response = await fetch(`${endpointPath(slug)}/forwarding`, withAuthHeaders(accessToken));
  return (await readJson<{ secret: string }>(response)).secret;
}

export async function rotateForwardSecret(accessToken: string, slug: string): Promise<string> {
  const response = await fetch(
    `${endpointPath(slug)}/forwarding`,
    withAuthHeaders(accessToken, { method: "POST" })
  );
  return (await readJson<{ secret: string }>(response)).secret;
}

export async function sendForwardTest(
  accessToken: string,
  slug: string,
  kind?: "http" | "email"
): Promise<ForwardTestResult> {
  const response = await fetch(
    `${endpointPath(slug)}/forwarding/test`,
    withAuthHeaders(accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(kind ? { kind } : {}),
    })
  );
  return readJson<ForwardTestResult>(response);
}

export async function fetchDeliveryLog(
  accessToken: string,
  slug: string,
  options: { limit?: number; status?: DeliveryLogFilter; before?: string | null } = {}
): Promise<LogDelivery[]> {
  // URLSearchParams encodes the "+" in a cursor's offset.
  const params = new URLSearchParams({
    limit: String(options.limit ?? 50),
    status: options.status ?? "all",
  });
  if (options.before) params.set("before", options.before);
  const response = await fetch(
    `${endpointPath(slug)}/deliveries?${params.toString()}`,
    withAuthHeaders(accessToken)
  );
  return readJson<LogDelivery[]>(response);
}

export async function fetchDeliverySummary(
  accessToken: string,
  slug: string
): Promise<DeliverySummary> {
  const response = await fetch(
    `${endpointPath(slug)}/deliveries/summary`,
    withAuthHeaders(accessToken)
  );
  return readJson<DeliverySummary>(response);
}

export class ForwardingOffError extends Error {}

/** Queues every failed delivery again, oldest first. Throws ForwardingOffError on 409. */
export async function redeliverAllFailed(
  accessToken: string,
  slug: string
): Promise<{ queued: number }> {
  const response = await fetch(
    `${endpointPath(slug)}/deliveries/redeliver-failed`,
    withAuthHeaders(accessToken, { method: "POST" })
  );
  if (response.status === 409) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ForwardingOffError(data?.error ?? "Turn forwarding on first.");
  }
  return readJson<{ queued: number }>(response);
}

export async function fetchRequestDeliveries(
  accessToken: string,
  requestId: string
): Promise<RequestDelivery[]> {
  const response = await fetch(
    `/api/requests/${encodeURIComponent(requestId)}/deliveries`,
    withAuthHeaders(accessToken)
  );
  return readJson<RequestDelivery[]>(response);
}

/** Forwards the request again with the current settings. Throws ForwardingOffError on 409. */
export async function redeliverRequest(accessToken: string, requestId: string): Promise<void> {
  const response = await fetch(
    `/api/requests/${encodeURIComponent(requestId)}/deliveries`,
    withAuthHeaders(accessToken, { method: "POST" })
  );
  if (response.status === 409) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ForwardingOffError(data?.error ?? "Turn forwarding on first.");
  }
  await readJson<{ id: string }>(response);
}

/** One captured request by id, for opening a delivery whose request the list has not loaded. */
export async function fetchDashboardRequestById(
  accessToken: string,
  requestId: string
): Promise<Request | null> {
  const response = await fetch(
    `/api/requests/${encodeURIComponent(requestId)}`,
    withAuthHeaders(accessToken)
  );
  if (response.status === 404) return null;
  return toDashboardRequest(await readJson<Parameters<typeof toDashboardRequest>[0]>(response));
}

export async function fetchDashboardEndpoints(
  accessToken: string
): Promise<DashboardEndpointsResponse> {
  const response = await fetch("/api/endpoints", withAuthHeaders(accessToken));
  return readJson<DashboardEndpointsResponse>(response);
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

export async function claimGuestEndpointForUser(
  accessToken: string,
  slug: string
): Promise<DashboardEndpoint | null> {
  const response = await fetch(
    "/api/endpoints/claim",
    withAuthHeaders(accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    })
  );
  if (response.status === 404) return null;
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
      signatureVerified?: boolean | null;
      signatureError?: string | null;
      signingProvider?: string | null;
      detectedProvider?: string | null;
      detectedEvent?: string | null;
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
