import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhooksCC } from "../client";
import { ApprovalDeniedError, ApprovalExpiredError } from "../errors";

const API_KEY = "whcc_testkey123";
const BASE_URL = "https://test.webhooks.cc";
const ID = "0b8d6a5e-1c2f-4f3a-9d7e-2a1b3c4d5e6f";

function client() {
  return new WebhooksCC({ apiKey: API_KEY, baseUrl: BASE_URL });
}

function answer(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function approval(status: string) {
  return {
    id: ID,
    status,
    action: "api_keys.create",
    summary: 'Create an API key named "CI" with full access to your account for 30 days.',
    code: "ABCD-EFGH",
    url: "https://webhooks.cc/approve?code=ABCD-EFGH",
    expiresAt: "2026-11-13T12:15:00.000Z",
  };
}

const created = {
  key: "whcc_new",
  name: "CI",
  keyPrefix: "whcc_new",
  expiresAt: "2026-12-13T12:00:00.000Z",
};

describe("apiKeys and approvals", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("asks for a key, then collects it once the person approves", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer({ approval: approval("pending") }, 202))
      .mockResolvedValueOnce(answer({ approval: approval("pending") }))
      .mockResolvedValueOnce(answer({ approval: approval("completed"), result: created }));
    globalThis.fetch = fetchMock;

    const pending = await client().apiKeys.create({ name: "CI", expiresInDays: 30 });
    expect(pending.url).toBe("https://webhooks.cc/approve?code=ABCD-EFGH");
    expect(pending.code).toBe("ABCD-EFGH");
    expect(await pending.wait({ pollInterval: 1_000 })).toEqual(created);

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/api-keys`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: "CI", expiresInDays: 30 });
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE_URL}/api/approvals/${ID}`);
  });

  it("throws when the person refuses, or nobody answers in time", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(answer({ approval: approval("denied") }));
    await expect(client().approvals.wait(ID)).rejects.toBeInstanceOf(ApprovalDeniedError);
    globalThis.fetch = vi.fn().mockResolvedValue(answer({ approval: approval("expired") }));
    await expect(client().approvals.wait(ID)).rejects.toBeInstanceOf(ApprovalExpiredError);
  });

  it("gives up after its own timeout", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(answer({ approval: approval("pending") }));
    await expect(client().approvals.wait(ID, { timeout: 0 })).rejects.toThrow(
      "Timed out waiting for the approval"
    );
  });

  it("never polls past its deadline, since a poll may collect the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer({ approval: approval("pending") }));
    globalThis.fetch = fetchMock;
    await expect(client().approvals.wait(ID, { timeout: 0 })).rejects.toThrow("Timed out");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry a poll that may have collected the result", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    globalThis.fetch = fetchMock;
    await expect(client().approvals.get(ID)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a rate-limited poll inside a wait", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ...answer({ error: "slow down" }, 429),
      headers: new Headers({ "content-type": "application/json", "retry-after": "30" }),
    });
    globalThis.fetch = fetchMock;
    await expect(client().approvals.wait(ID, { timeout: 5_000 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not start a poll after a token renewal used up its time", async () => {
    let calls = 0;
    const getAccessToken = vi.fn(async (options?: { forceRefresh?: boolean }) => {
      // The renewal after the 401 takes longer than the budget left.
      if (options?.forceRefresh) await new Promise((resolve) => setTimeout(resolve, 80));
      return "whcc_token";
    });
    const fetchMock = vi.fn(async () => {
      calls++;
      return answer({ error: "expired" }, 401);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const agent = new WebhooksCC({ baseUrl: BASE_URL, getAccessToken });
    await expect(agent.approvals.get(ID, { timeout: 50 })).rejects.toThrow("timed out");
    expect(calls).toBe(1);
  });

  it("returns by its deadline even when the token never comes", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const agent = new WebhooksCC({
      baseUrl: BASE_URL,
      getAccessToken: () => new Promise<string>(() => {}),
    });
    const started = Date.now();
    await expect(agent.approvals.wait(ID, { timeout: 60 })).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to hand over a result twice", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(answer({ approval: approval("completed") }));
    await expect(client().approvals.wait(ID)).rejects.toThrow("already collected");
  });

  it("lists and revokes keys", async () => {
    const list = [{ id: ID, name: "CI", key_prefix: "whcc_abc", created_at: "x" }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer(list))
      .mockResolvedValueOnce(answer({ success: true }));
    globalThis.fetch = fetchMock;
    expect(await client().apiKeys.list()).toEqual(list);
    await client().apiKeys.revoke(ID);
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE_URL}/api/api-keys?id=${ID}`);
    expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
  });
});

describe("teams and layouts without the dashboard", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  const TEAM = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

  it("asks to delete a team, then reports it once the owner approves", async () => {
    const asked = { ...approval("pending"), action: "teams.delete" };
    const done = { ...approval("completed"), action: "teams.delete" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer({ approval: asked }, 202))
      .mockResolvedValueOnce(answer({ approval: done, result: { deleted: "Acme", teamId: TEAM } }));
    globalThis.fetch = fetchMock;

    const pending = await client().teams.delete(TEAM);
    expect(pending.action).toBe("teams.delete");
    expect(await pending.wait({ pollInterval: 1_000 })).toEqual({ deleted: "Acme", teamId: TEAM });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/teams/${TEAM}`);
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });

  it("deletes at once when the answer is not an approval", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 204,
      headers: new Headers(),
      json: () => Promise.reject(new Error("no body")),
      text: () => Promise.resolve(""),
    });
    const pending = await client().teams.delete(TEAM);
    expect(pending.status).toBe("completed");
    expect(await pending.wait()).toEqual({ deleted: "", teamId: TEAM });
  });

  it("creates, renames, leaves, removes members and withdraws invites", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(answer({ id: TEAM })));
    globalThis.fetch = fetchMock;
    await client().teams.create("Acme");
    await client().teams.rename(TEAM, "Acme Inc");
    await client().teams.removeMember(TEAM, "u1");
    await client().teams.leave(TEAM);
    await client().teams.withdrawInvite(TEAM, "i1");
    const calls = fetchMock.mock.calls.map(([url, opts]) => [
      opts.method,
      url.replace(BASE_URL, ""),
      opts.body ? JSON.parse(opts.body) : undefined,
    ]);
    expect(calls).toEqual([
      ["POST", "/api/teams", { name: "Acme" }],
      ["PATCH", `/api/teams/${TEAM}`, { name: "Acme Inc" }],
      ["DELETE", `/api/teams/${TEAM}/members/u1`, undefined],
      ["POST", `/api/teams/${TEAM}/leave`, undefined],
      ["DELETE", `/api/teams/${TEAM}/invites/i1`, undefined],
    ]);
    await expect(client().teams.create(" ")).rejects.toThrow("team name");
  });

  it("lists and adds layout templates, and previews email fields", async () => {
    const templates = [
      {
        id: "shopify-orders",
        sender: "Shopify",
        kind: "order notifications",
        description: "x",
        fields: ["order"],
        lineItems: true,
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer({ templates }))
      .mockResolvedValueOnce(answer({ layoutId: "shopify-orders" }, 201))
      .mockResolvedValueOnce(answer({ problems: [], request: null, values: null }));
    globalThis.fetch = fetchMock;
    expect(await client().endpoints.layoutTemplates("abc")).toEqual(templates);
    expect(await client().endpoints.addLayoutTemplate("abc", "shopify-orders")).toEqual({
      layoutId: "shopify-orders",
    });
    await client().endpoints.previewEmailFields("abc", { requestId: ID });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/endpoints/abc/layouts/template`);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ template: "shopify-orders" });
    expect(fetchMock.mock.calls[2][0]).toBe(`${BASE_URL}/api/endpoints/abc/email-fields/preview`);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ requestId: ID });
  });
});

describe("billing changes", () => {
  const TEAM = "4f8d6a5e-1c2f-4f3a-9d7e-2a1b3c4d5e6f";
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("asks the owner, then hands over what was done", async () => {
    const asked = { ...approval("pending"), action: "billing.change" };
    const done = { ...approval("completed"), action: "billing.change" };
    const result = { executed: true, applied: "now", change: 'Change the team "Acme".' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer({ approval: asked }, 202))
      .mockResolvedValueOnce(answer({ approval: done, result }));
    globalThis.fetch = fetchMock;

    const pending = await client().billing.setSeats(TEAM, 5);
    expect(pending.action).toBe("billing.change");
    expect(await pending.wait({ pollInterval: 1_000 })).toEqual(result);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/teams/${TEAM}/billing/seats`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ seats: 5 });
  });

  it("sends each change to its route", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          answer({ approval: { ...approval("pending"), action: "billing.change" } }, 202)
        )
      );
    globalThis.fetch = fetchMock;
    const billing = client().billing;
    await billing.changePlan({ plan: "business", interval: "year" });
    await billing.changePlan({ plan: "team_business", teamId: TEAM });
    await billing.keepPlan();
    await billing.keepPlan({ teamId: TEAM });
    await billing.setMonthlyBlocks({ blocks: 2, resource: "pages" });
    await billing.buyBlocks({ blocks: 1, teamId: TEAM });
    await billing.setOverage({ enabled: true, maxBlocks: 4 });
    await billing.cancel();
    await billing.resubscribe({ teamId: TEAM });
    const calls = fetchMock.mock.calls.map(([url, opts]) => [
      opts.method,
      url.replace(BASE_URL, ""),
      opts.body ? JSON.parse(opts.body) : undefined,
    ]);
    expect(calls).toEqual([
      ["POST", "/api/billing/change-plan", { plan: "business", interval: "year" }],
      ["POST", `/api/teams/${TEAM}/billing/plan`, { plan: "team_business", interval: "month" }],
      ["DELETE", "/api/billing/change-plan", undefined],
      ["POST", `/api/teams/${TEAM}/billing/plan`, { action: "keep" }],
      [
        "POST",
        "/api/billing/capacity",
        { action: "set_monthly_blocks", blocks: 2, resource: "pages" },
      ],
      [
        "POST",
        `/api/teams/${TEAM}/billing/capacity`,
        { action: "buy_blocks", blocks: 1, resource: "requests" },
      ],
      [
        "POST",
        "/api/billing/capacity",
        { action: "set_overage", enabled: true, maxBlocks: 4, resource: "requests" },
      ],
      ["POST", "/api/billing/cancel", {}],
      ["POST", `/api/teams/${TEAM}/billing/resubscribe`, {}],
    ]);
    await expect(billing.changePlan({ plan: "team" })).rejects.toThrow("teamId");
    await expect(billing.changePlan({ plan: "pro", teamId: TEAM })).rejects.toThrow("own plans");
  });

  it("hands over a refusal on a fresh quote as executed: false", async () => {
    const result = { executed: false, code: "quote_changed", reason: "Nothing was changed." };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        answer({ approval: { ...approval("pending"), action: "billing.change" } }, 202)
      )
      .mockResolvedValueOnce(
        answer({ approval: { ...approval("completed"), action: "billing.change" }, result })
      );
    const pending = await client().billing.cancel();
    expect(await pending.wait({ pollInterval: 1_000 })).toEqual(result);
  });
});
