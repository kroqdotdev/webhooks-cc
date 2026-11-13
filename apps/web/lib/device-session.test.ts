import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
  owesSecondFactor: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser, getSession: mocks.getSession },
  }),
}));
vi.mock("@/lib/mfa-session", () => ({ owesSecondFactor: mocks.owesSecondFactor }));

import { deviceApprover } from "./device-session";

const user = { id: "user-1", email: "dev@example.com" };

describe("deviceApprover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: "jwt" } } });
    mocks.owesSecondFactor.mockResolvedValue(false);
  });

  it("is the signed-in person", async () => {
    expect(await deviceApprover()).toEqual({ userId: "user-1", email: "dev@example.com" });
  });

  it("refuses a browser that is not signed in", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const result = await deviceApprover();
    expect("error" in result && result.error.status).toBe(401);
  });

  it("refuses a session that skipped the account's two-factor sign-in", async () => {
    mocks.owesSecondFactor.mockResolvedValue(true);
    const result = await deviceApprover();
    expect("error" in result && result.error.status).toBe(401);
    expect(mocks.owesSecondFactor).toHaveBeenCalledWith(user, "jwt");
  });
});
