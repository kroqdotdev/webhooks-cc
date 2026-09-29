import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const eq = vi.fn();
const update = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ update }));
const sendEmail = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc, from }),
}));
vi.mock("@/lib/email/mailer", () => ({ sendEmail: (...args: unknown[]) => sendEmail(...args) }));
vi.mock("@/lib/env", () => ({
  publicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://webhooks.cc" }),
}));

const { sendQuotaExhaustedEmails } = await import("./quota-emails");

const claimed = [
  {
    id: "u1",
    email: "a@example.com",
    request_limit: 50,
    period_end: "2026-09-29T18:00:00Z",
    team_billed_endpoints: 0,
  },
  {
    id: "u2",
    email: "b@example.com",
    request_limit: 50,
    period_end: "2026-09-29T19:00:00Z",
    team_billed_endpoints: 1,
  },
];

describe("sendQuotaExhaustedEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eq.mockResolvedValue({ error: null });
  });

  it("emails every claimed user and marks each one sent", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "claim_quota_exhausted_users" ? { data: claimed, error: null } : { error: null }
    );
    sendEmail.mockResolvedValue(undefined);

    await expect(sendQuotaExhaustedEmails()).resolves.toEqual({ sent: 2, failed: 0 });
    expect(rpc).toHaveBeenCalledWith("claim_quota_exhausted_users", { p_limit: 50 });
    expect(sendEmail.mock.calls.map(([m]) => m.to)).toEqual(["a@example.com", "b@example.com"]);
    expect(rpc).toHaveBeenCalledWith("mark_quota_email_sent", { p_user_id: "u1" });
    expect(rpc).toHaveBeenCalledWith("mark_quota_email_sent", { p_user_id: "u2" });
    expect(update).not.toHaveBeenCalled();
  });

  it("releases the lease and does not mark sent when a send fails", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "claim_quota_exhausted_users" ? { data: claimed, error: null } : { error: null }
    );
    sendEmail.mockRejectedValueOnce(new Error("smtp down")).mockResolvedValueOnce(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendQuotaExhaustedEmails()).resolves.toEqual({ sent: 1, failed: 1 });
    expect(update).toHaveBeenCalledWith({ quota_email_claimed_at: null });
    expect(eq).toHaveBeenCalledWith("id", "u1");
    expect(rpc).not.toHaveBeenCalledWith("mark_quota_email_sent", { p_user_id: "u1" });
    expect(rpc).toHaveBeenCalledWith("mark_quota_email_sent", { p_user_id: "u2" });
  });

  it("throws when the claim fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(sendQuotaExhaustedEmails()).rejects.toThrow("boom");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
