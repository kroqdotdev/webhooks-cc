import type { ApiShare, ApiTunnelLimits, ApiTunnelUsage } from "@/lib/tunnels/listing";
import type { ApiName } from "@/lib/tunnels/name-api";

/*
 * The browser's calls to the sharing routes (whk share previews): the Shares
 * page lists, stops, and keeps names with the session's bearer token, as the
 * CLI does with its key.
 */

export type { ApiName, ApiShare, ApiTunnelLimits, ApiTunnelUsage };

export interface SharesListing {
  shares: ApiShare[];
  usage: ApiTunnelUsage;
  limits: ApiTunnelLimits;
}

export interface NamesListing {
  names: ApiName[];
  limit: number;
  used: number;
}

export interface SeenRequest {
  method: string;
  path: string;
  status: number;
  ms: number;
  bytes: number;
  at: string;
  country: string | null;
  device: string | null;
  visitor: number | null;
}

/** A refused call, with its status: 503 means sharing is not set up on this server. */
export class SharesApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "SharesApiError";
  }
}

async function call<T>(
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `Request failed (${response.status})`;
    throw new SharesApiError(message, response.status);
  }
  return data as T;
}

export function listShares(accessToken: string): Promise<SharesListing> {
  return call(accessToken, "/api/shares");
}

export function stopShare(accessToken: string, id: string): Promise<{ ok: boolean }> {
  return call(accessToken, `/api/shares/${encodeURIComponent(id)}/stop`, {
    method: "POST",
    body: {},
  });
}

export function shareRequests(
  accessToken: string,
  id: string
): Promise<{ available: boolean; requests: SeenRequest[] }> {
  return call(accessToken, `/api/shares/${encodeURIComponent(id)}/requests`);
}

export function listNames(accessToken: string): Promise<NamesListing> {
  return call(accessToken, "/api/tunnel-names");
}

export function reserveName(
  accessToken: string,
  name: string,
  team: string | null
): Promise<{ name: ApiName }> {
  return call(accessToken, "/api/tunnel-names", {
    method: "POST",
    body: team ? { name, team } : { name },
  });
}

export function releaseName(accessToken: string, name: string): Promise<{ ok: boolean }> {
  return call(accessToken, `/api/tunnel-names/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export function setNamePassword(
  accessToken: string,
  name: string,
  password: string | null
): Promise<{ ok: boolean; password: boolean }> {
  return call(accessToken, `/api/tunnel-names/${encodeURIComponent(name)}/password`, {
    method: password === null ? "DELETE" : "PUT",
    body: password === null ? undefined : { password },
  });
}

/** Live first (newest first), then ended (newest first). */
export function splitShares(shares: ApiShare[]): { live: ApiShare[]; ended: ApiShare[] } {
  const byStart = (a: ApiShare, b: ApiShare) => Date.parse(b.startedAt) - Date.parse(a.startedAt);
  return {
    live: shares.filter((s) => s.endedAt === null).sort(byStart),
    ended: shares.filter((s) => s.endedAt !== null).sort(byStart),
  };
}

/** The share of the month's data used, 0 to 100. */
export function usagePercent(usage: ApiTunnelUsage): number {
  if (usage.limitBytes <= 0) return 100;
  return Math.min(100, Math.round((usage.bytes / usage.limitBytes) * 100));
}

/** "18 min", "2 h 5 min", "3 d": how long a share has run or ran. */
export function durationText(fromIso: string, toIso: string | null, now = Date.now()): string {
  const end = toIso ? Date.parse(toIso) : now;
  const minutes = Math.max(0, Math.round((end - Date.parse(fromIso)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  return `${Math.floor(hours / 24)} d`;
}
