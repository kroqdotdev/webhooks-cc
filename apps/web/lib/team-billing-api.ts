"use client";

import type { PlanChangeQuote, SeatChangeQuote, TeamInterval, TeamPlan } from "@/lib/team-pricing";

/**
 * Browser-side wrappers for `/api/teams/[teamId]/billing/*`.
 *
 * Checkout answers 200 `{ url }` and a plan change `{ applied }`; cancel,
 * resubscribe, seats and keeping the plan answer 204 with an empty body, so
 * those never parse a response. Failures always carry a
 * JSON `{ error }` string, optionally with a `detail` string (e.g. Polar
 * validation detail); both are folded into the thrown message for inline
 * display.
 */

function billingRequest(accessToken: string, body?: unknown): RequestInit {
  const headers = new Headers({ Authorization: `Bearer ${accessToken}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function readError(response: Response): Promise<string> {
  const data = (await response.json().catch(() => null)) as {
    error?: unknown;
    detail?: unknown;
  } | null;
  const message =
    typeof data?.error === "string" ? data.error : `Request failed (${response.status})`;
  return typeof data?.detail === "string" && data.detail.length > 0
    ? `${message}: ${data.detail}`
    : message;
}

export async function startTeamCheckout(
  accessToken: string,
  teamId: string,
  seats: number,
  plan: TeamPlan = "team",
  interval: TeamInterval = "month"
): Promise<string> {
  const response = await fetch(
    `/api/teams/${teamId}/billing/checkout`,
    billingRequest(accessToken, { seats, plan, interval })
  );
  if (!response.ok) throw new Error(await readError(response));

  const data = (await response.json().catch(() => null)) as { url?: unknown } | null;
  if (typeof data?.url !== "string") throw new Error("Checkout did not return a redirect URL");
  return data.url;
}

export async function cancelTeamSubscription(accessToken: string, teamId: string): Promise<void> {
  const response = await fetch(`/api/teams/${teamId}/billing/cancel`, billingRequest(accessToken));
  if (!response.ok) throw new Error(await readError(response));
}

export async function resubscribeTeamSubscription(
  accessToken: string,
  teamId: string
): Promise<void> {
  const response = await fetch(
    `/api/teams/${teamId}/billing/resubscribe`,
    billingRequest(accessToken)
  );
  if (!response.ok) throw new Error(await readError(response));
}

export async function updateTeamSeats(
  accessToken: string,
  teamId: string,
  seats: number
): Promise<void> {
  const response = await fetch(
    `/api/teams/${teamId}/billing/seats`,
    billingRequest(accessToken, { seats })
  );
  if (!response.ok) throw new Error(await readError(response));
}

/** Exact charge or credit for changing to `seats`, priced by the server from Polar's data. */
export async function quoteTeamSeats(
  accessToken: string,
  teamId: string,
  seats: number
): Promise<SeatChangeQuote> {
  const response = await fetch(
    `/api/teams/${teamId}/billing/seats?seats=${encodeURIComponent(String(seats))}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as SeatChangeQuote;
}

/** About what moving to a plan costs now, priced by the server from Polar's data. */
export async function quoteTeamPlan(
  accessToken: string,
  teamId: string,
  plan: TeamPlan,
  interval: TeamInterval
): Promise<PlanChangeQuote> {
  const query = new URLSearchParams({ plan, interval });
  const response = await fetch(`/api/teams/${teamId}/billing/plan?${query.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as PlanChangeQuote;
}

/** Moves the team to a plan: an upgrade applies now, a downgrade at the renewal. */
export async function changeTeamPlan(
  accessToken: string,
  teamId: string,
  plan: TeamPlan,
  interval: TeamInterval
): Promise<{ applied: "now" | "renewal"; seatReductionLost?: number }> {
  const response = await fetch(
    `/api/teams/${teamId}/billing/plan`,
    billingRequest(accessToken, { plan, interval })
  );
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as { applied: "now" | "renewal"; seatReductionLost?: number };
}

/** Drops a plan change waiting for the renewal. */
export async function keepTeamPlan(accessToken: string, teamId: string): Promise<void> {
  const response = await fetch(
    `/api/teams/${teamId}/billing/plan`,
    billingRequest(accessToken, { action: "keep" })
  );
  if (!response.ok) throw new Error(await readError(response));
}
