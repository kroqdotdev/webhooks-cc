"use client";

/**
 * Browser-side wrappers for `/api/teams/[teamId]/billing/*`.
 *
 * Checkout answers 200 `{ url }`; cancel, resubscribe and seats answer 204 with
 * an empty body, so those three never parse a response. Failures always carry a
 * JSON `{ error }` string, which is rethrown verbatim for inline display.
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
  const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof data?.error === "string" ? data.error : `Request failed (${response.status})`;
}

export async function startTeamCheckout(
  accessToken: string,
  teamId: string,
  seats: number
): Promise<string> {
  const response = await fetch(
    `/api/teams/${teamId}/billing/checkout`,
    billingRequest(accessToken, { seats })
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
