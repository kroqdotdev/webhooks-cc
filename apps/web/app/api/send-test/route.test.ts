import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ RECEIVER_INTERNAL_URL: "http://receiver.test" }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimitWithInfo: vi.fn().mockResolvedValue({ allowed: true }),
  applyRateLimitHeaders: (response: Response) => response,
  getClientIp: () => "203.0.113.7",
}));

function postRequest(body: string) {
  return new Request("https://webhooks.cc/api/send-test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function send(body: string) {
  const { POST } = await import("./route");
  const response = await POST(postRequest(body));
  return { status: response.status, body: await response.json() };
}

describe("POST /api/send-test", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.authenticateRequest.mockResolvedValue({ success: true, userId: "user_1" });
    mocks.fetch.mockResolvedValue(new Response("ok", { status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test.each([
    "null",
    "[]",
    '"text"',
    "{",
    '{"method":1,"slug":"acme"}',
    '{"method":"POST","slug":"acme","path":5}',
    '{"method":"POST","slug":"acme","path":{"a":1}}',
  ])("answers 400 to the malformed body %s", async (body) => {
    expect(await send(body)).toEqual({ status: 400, body: { error: "Invalid JSON" } });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test("keeps the message of each field", async () => {
    expect((await send("{}")).body).toEqual({ error: "Invalid method" });
    expect((await send('{"method":"TRACE","slug":"acme"}')).body).toEqual({
      error: "Invalid method",
    });
    expect((await send('{"method":"POST"}')).body).toEqual({ error: "Invalid slug" });
    expect((await send('{"method":"POST","slug":"a b"}')).body).toEqual({ error: "Invalid slug" });
    expect((await send('{"method":"POST","slug":{"a":1}}')).body).toEqual({
      error: "Invalid slug",
    });
    expect((await send('{"method":"POST","slug":"acme","path":"/../x"}')).body).toEqual({
      error: "Invalid path",
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test("sends to the receiver without the caller's IP headers", async () => {
    const result = await send(
      JSON.stringify({
        method: "post",
        slug: "acme",
        path: "hook",
        headers: { "X-Real-Ip": "198.51.100.1", "X-Test": "1" },
        body: "{}",
      })
    );

    expect(result).toEqual({ status: 200, body: { status: 200, statusText: "OK", body: "ok" } });
    expect(mocks.fetch).toHaveBeenCalledWith("http://receiver.test/w/acme/hook", {
      method: "POST",
      headers: { "X-Test": "1", "X-Webhooks-CC-Test-Send": "1", "X-Real-Ip": "203.0.113.7" },
      body: "{}",
    });
  });
});
