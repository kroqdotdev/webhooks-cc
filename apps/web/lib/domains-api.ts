import type { DomainRoute, InboundDomain } from "@/lib/supabase/inbound-domains";

export type { DomainRoute, InboundDomain };

/** Client calls for /api/domains (custom inbound domains); `teamId` for a team's. */
function domainsUrl(path: string, teamId?: string): string {
  return teamId ? `/api/domains${path}?team=${encodeURIComponent(teamId)}` : `/api/domains${path}`;
}

async function call<T>(
  accessToken: string,
  path: string,
  teamId: string | undefined,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(domainsUrl(path, teamId), {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(data?.error ?? `Request failed (${response.status})`);
  return data as T;
}

export async function fetchDomains(accessToken: string, teamId?: string) {
  return (await call<{ domains: InboundDomain[] }>(accessToken, "", teamId)).domains;
}

export async function addDomainRequest(accessToken: string, domain: string, teamId?: string) {
  return (
    await call<{ domain: InboundDomain }>(accessToken, "", teamId, {
      method: "POST",
      body: JSON.stringify({ domain }),
    })
  ).domain;
}

export async function verifyDomainRequest(accessToken: string, id: string, teamId?: string) {
  return call<{ domain: InboundDomain; records: { txt: boolean; mx: boolean } }>(
    accessToken,
    `/${id}/verify`,
    teamId,
    { method: "POST" }
  );
}

export async function saveDomainRouting(
  accessToken: string,
  id: string,
  routing: { catchAllEndpointId: string | null; routes: DomainRoute[] },
  teamId?: string
) {
  return (
    await call<{ domain: InboundDomain }>(accessToken, `/${id}`, teamId, {
      method: "PATCH",
      body: JSON.stringify(routing),
    })
  ).domain;
}

export async function removeDomainRequest(accessToken: string, id: string, teamId?: string) {
  await call<void>(accessToken, `/${id}`, teamId, { method: "DELETE" });
}
