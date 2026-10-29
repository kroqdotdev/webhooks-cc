"use client";

import type { CapacityAction } from "@/lib/capacity-route";
import type { CapacityResource, CapacityState } from "@/lib/supabase/capacity-billing";

/**
 * Browser-side wrappers for `/api/billing/capacity` and
 * `/api/teams/[teamId]/billing/capacity`. A change answers either a checkout
 * `{ url }` to send the browser to, or the new `{ state }`.
 */

function capacityUrl(teamId?: string): string {
  return teamId
    ? `/api/teams/${encodeURIComponent(teamId)}/billing/capacity`
    : "/api/billing/capacity";
}

async function readError(response: Response): Promise<string> {
  const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof data?.error === "string" ? data.error : `Request failed (${response.status})`;
}

export async function fetchCapacity(
  accessToken: string,
  teamId?: string,
  resource: CapacityResource = "requests"
): Promise<CapacityState> {
  const url =
    resource === "requests" ? capacityUrl(teamId) : `${capacityUrl(teamId)}?resource=${resource}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as CapacityState;
}

export async function changeCapacity(
  accessToken: string,
  action: CapacityAction,
  teamId?: string
): Promise<{ url: string } | { state: CapacityState }> {
  const response = await fetch(capacityUrl(teamId), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as { url: string } | { state: CapacityState };
}
