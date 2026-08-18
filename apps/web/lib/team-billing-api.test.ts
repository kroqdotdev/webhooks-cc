import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  cancelTeamSubscription,
  resubscribeTeamSubscription,
  startTeamCheckout,
  updateTeamSeats,
} from "./team-billing-api";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("startTeamCheckout", () => {
  test("posts the seat count and returns the checkout url", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ url: "https://polar.test/checkout/abc" }, 200));

    const url = await startTeamCheckout("token-1", "team-1", 3);

    expect(url).toBe("https://polar.test/checkout/abc");
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/teams/team-1/billing/checkout");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ seats: 3 }));
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token-1");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  test("surfaces the server error message", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Team already has an active subscription" }, 409)
    );

    await expect(startTeamCheckout("token-1", "team-1", 3)).rejects.toThrow(
      "Team already has an active subscription"
    );
  });

  test("falls back to the status code when the body carries no error string", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 502 }));

    await expect(startTeamCheckout("token-1", "team-1", 3)).rejects.toThrow("Request failed (502)");
  });

  test("rejects a success response without a url", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 200));

    await expect(startTeamCheckout("token-1", "team-1", 3)).rejects.toThrow(
      "Checkout did not return a redirect URL"
    );
  });
});

describe("204 routes", () => {
  test("cancelTeamSubscription resolves without reading the empty body", async () => {
    const response = new Response(null, { status: 204 });
    const jsonSpy = vi.spyOn(response, "json");
    fetchMock.mockResolvedValue(response);

    await expect(cancelTeamSubscription("token-1", "team-1")).resolves.toBeUndefined();

    expect(jsonSpy).not.toHaveBeenCalled();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/teams/team-1/billing/cancel");
    expect(init.body).toBeUndefined();
  });

  test("resubscribeTeamSubscription resolves without reading the empty body", async () => {
    const response = new Response(null, { status: 204 });
    const jsonSpy = vi.spyOn(response, "json");
    fetchMock.mockResolvedValue(response);

    await expect(resubscribeTeamSubscription("token-1", "team-1")).resolves.toBeUndefined();

    expect(jsonSpy).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/teams/team-1/billing/resubscribe");
  });

  test("updateTeamSeats posts the seat count and resolves on 204", async () => {
    const response = new Response(null, { status: 204 });
    const jsonSpy = vi.spyOn(response, "json");
    fetchMock.mockResolvedValue(response);

    await expect(updateTeamSeats("token-1", "team-1", 5)).resolves.toBeUndefined();

    expect(jsonSpy).not.toHaveBeenCalled();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/teams/team-1/billing/seats");
    expect(init.body).toBe(JSON.stringify({ seats: 5 }));
  });

  test("updateTeamSeats surfaces the seats-below-members conflict", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Team has 4 members — remove members before reducing to 2 seats" }, 409)
    );

    await expect(updateTeamSeats("token-1", "team-1", 2)).rejects.toThrow(
      "Team has 4 members — remove members before reducing to 2 seats"
    );
  });

  test("resubscribeTeamSubscription surfaces a not-owner rejection", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Only the team owner can manage billing" }, 403)
    );

    await expect(resubscribeTeamSubscription("token-1", "team-1")).rejects.toThrow(
      "Only the team owner can manage billing"
    );
  });
});
