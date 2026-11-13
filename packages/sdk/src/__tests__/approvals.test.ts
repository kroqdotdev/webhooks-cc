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
    expect(await pending.wait({ pollInterval: 500 })).toEqual(created);

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
