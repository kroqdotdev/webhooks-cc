import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  deviceApprover: vi.fn(),
  describeDeviceCode: vi.fn(),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/device-session", () => ({ deviceApprover: mocks.deviceApprover }));
vi.mock("@/lib/supabase/device-auth", () => ({ describeDeviceCode: mocks.describeDeviceCode }));

import { GET } from "./route";

function get(code: string | null, ip = "203.0.113.9") {
  const url = new URL("https://webhooks.cc/api/auth/device-request");
  if (code !== null) url.searchParams.set("code", code);
  return new Request(url, { headers: { "cf-connecting-ip": ip } });
}

describe("GET /api/auth/device-request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue(null);
    mocks.deviceApprover.mockResolvedValue({ userId: "user-1", email: null });
  });

  it("describes the login, compared with the browser's network", async () => {
    mocks.describeDeviceCode.mockResolvedValue({ userCode: "ABCD-EFGH", network: "same" });
    const response = await GET(get("ABCD-EFGH"));
    expect(response.status).toBe(200);
    expect(mocks.describeDeviceCode).toHaveBeenCalledWith("ABCD-EFGH", "203.0.113.0/24");
  });

  it("answers 404 for a code that is gone", async () => {
    mocks.describeDeviceCode.mockResolvedValue(null);
    expect((await GET(get("ABCD-EFGH"))).status).toBe(404);
  });

  it("refuses without an approver, before reading the code", async () => {
    mocks.deviceApprover.mockResolvedValue({
      error: Response.json({ error: "Enter your two-factor code first." }, { status: 401 }),
    });
    expect((await GET(get("ABCD-EFGH"))).status).toBe(401);
    expect(mocks.describeDeviceCode).not.toHaveBeenCalled();
  });

  it("needs a code of a sensible length", async () => {
    expect((await GET(get(null))).status).toBe(400);
    expect((await GET(get("x".repeat(40)))).status).toBe(400);
  });
});
