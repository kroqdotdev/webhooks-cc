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

export type PaidPlan = "pro" | "business";
export type BillingInterval = "month" | "year";

export async function createBillingCheckout(
  accessToken: string,
  plan: PaidPlan = "pro",
  interval: BillingInterval = "month"
): Promise<string> {
  const response = await fetch(
    "/api/billing/checkout",
    withAuthHeaders(accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, interval }),
    })
  );
  const data = await readJson<{ url: string }>(response);
  return data.url;
}

/** Moves a paying account to another plan: up now, down at the renewal. */
export async function changeBillingPlan(
  accessToken: string,
  plan: PaidPlan,
  interval: BillingInterval
): Promise<{ applied: "now" | "renewal" }> {
  const response = await fetch(
    "/api/billing/change-plan",
    withAuthHeaders(accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, interval }),
    })
  );
  return readJson<{ applied: "now" | "renewal" }>(response);
}

/** Drops a plan change that waits for the renewal. */
export async function keepBillingPlan(accessToken: string): Promise<void> {
  const response = await fetch(
    "/api/billing/change-plan",
    withAuthHeaders(accessToken, { method: "DELETE" })
  );
  await readJson<{ ok: true }>(response);
}

/** What each paid plan costs, for display (Polar holds the charged prices). */
export const PLAN_PRICES: Record<PaidPlan, Partial<Record<BillingInterval, string>>> = {
  pro: { month: "$8 a month" },
  business: { month: "$29 a month", year: "$290 a year" },
};

export function planName(plan: string): string {
  return plan === "business" ? "Business" : plan === "pro" ? "Pro" : "Free";
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
