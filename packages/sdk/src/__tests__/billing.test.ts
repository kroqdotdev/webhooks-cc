import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhooksCC } from "../client";

const BASE_URL = "https://test.webhooks.cc";
const TEAM = "0b8d6a5e-1c2f-4f3a-9d7e-2a1b3c4d5e6f";

function answer(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe("billing", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reads the summary, add-ons and team quotes from their routes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer({ plan: "pro" }));
    globalThis.fetch = fetchMock;
    const client = new WebhooksCC({ apiKey: "whcc_test", baseUrl: BASE_URL });

    expect(await client.billing.get()).toEqual({ plan: "pro" });
    await client.billing.capacity();
    await client.billing.capacity({ resource: "pages", teamId: TEAM });
    await client.billing.quoteTeamPlan(TEAM, "team_business", "year");
    await client.billing.quoteTeamSeats(TEAM, 5);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `${BASE_URL}/api/billing`,
      `${BASE_URL}/api/billing/capacity?resource=requests`,
      `${BASE_URL}/api/teams/${TEAM}/billing/capacity?resource=pages`,
      `${BASE_URL}/api/teams/${TEAM}/billing/plan?plan=team_business&interval=year`,
      `${BASE_URL}/api/teams/${TEAM}/billing/seats?seats=5`,
    ]);
    for (const call of fetchMock.mock.calls) expect(call[1].method).toBe("GET");
  });
});
