import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  createDeviceCodeRecord: vi.fn(),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/supabase/device-auth", () => ({
  createDeviceCodeRecord: mocks.createDeviceCodeRecord,
}));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({}) }));

import { POST } from "./route";

function post(body: string | undefined) {
  return new Request("https://webhooks.cc/api/auth/device-code", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "whk-cli/1.11.0",
      "cf-connecting-ip": "203.0.113.9",
    },
    body,
  });
}

describe("POST /api/auth/device-code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue(null);
    mocks.createDeviceCodeRecord.mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      expiresAt: 1,
    });
  });

  it("returns the page with the code in it", async () => {
    const response = await POST(post("{}"));
    const body = await response.json();
    expect(body.verificationUrl).toMatch(/\/cli\/verify$/);
    expect(body.verificationUrlComplete).toBe(`${body.verificationUrl}?code=ABCD-EFGH`);
  });

  it("records what the client says, and the network it came from", async () => {
    await POST(post(JSON.stringify({ client: "whk 1.13.0 on linux", remote: true })));
    expect(mocks.createDeviceCodeRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        client: "whk 1.13.0 on linux",
        remote: true,
        network: "203.0.113.0/24",
      })
    );
  });

  it("still makes a code for an old client, an empty body or one too large", async () => {
    for (const body of [undefined, "", "not json", JSON.stringify({ client: "x".repeat(5000) })]) {
      const response = await POST(post(body));
      expect(response.status).toBe(200);
    }
    // The oversized body was not read: the client falls back to the user agent.
    expect(mocks.createDeviceCodeRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({ client: "whk-cli/1.11.0", remote: false })
    );
  });
});
