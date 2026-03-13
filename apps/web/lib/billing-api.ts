"use client";

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

export async function createBillingCheckout(accessToken: string): Promise<string> {
  const response = await fetch(
    "/api/billing/checkout",
    withAuthHeaders(accessToken, { method: "POST" })
  );
  const data = await readJson<{ url: string }>(response);
  return data.url;
}

export async function cancelBillingSubscription(accessToken: string): Promise<void> {
  const response = await fetch(
    "/api/billing/cancel",
    withAuthHeaders(accessToken, { method: "POST" })
  );
  await readJson<{ success: true }>(response);
}

export async function resubscribeBillingSubscription(accessToken: string): Promise<void> {
  const response = await fetch(
    "/api/billing/resubscribe",
    withAuthHeaders(accessToken, { method: "POST" })
  );
  await readJson<{ success: true }>(response);
}

export async function deleteAccount(accessToken: string): Promise<void> {
  const response = await fetch("/api/account", withAuthHeaders(accessToken, { method: "DELETE" }));
  await readJson<{ success: true }>(response);
}
