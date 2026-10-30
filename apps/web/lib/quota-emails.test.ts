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
const getCapacityProductIds = vi.fn();
vi.mock("@/lib/polar", () => ({ getCapacityProductIds: () => getCapacityProductIds() }));

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
    getCapacityProductIds.mockReturnValue({
      oneTime: "p1",
      monthly: "p2",
      monthlyAdd: "p3",
      overage: "p4",
    });
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

  it("names this period's rejected webhooks in each email", async () => {
    rpc.mockImplementation(async (fn: string, args?: { p_user_id?: string }) => {
      if (fn === "claim_quota_exhausted_users") return { data: claimed, error: null };
      if (fn === "get_quota_rejections") {
        return args?.p_user_id === "u1"
          ? {
              data: [
                { slug: "stripe-prod", quota_rejected: 7, total_rejected: 9, endpoint_count: 2 },
                { slug: "gh-staging", quota_rejected: 2, total_rejected: 9, endpoint_count: 2 },
              ],
              error: null,
            }
          : { data: [], error: null };
      }
      return { error: null };
    });
    sendEmail.mockResolvedValue(undefined);

    await expect(sendQuotaExhaustedEmails()).resolves.toEqual({ sent: 2, failed: 0 });
    expect(rpc).toHaveBeenCalledWith("get_quota_rejections", { p_user_id: "u1", p_limit: 5 });
    expect(rpc).toHaveBeenCalledWith("get_quota_rejections", { p_user_id: "u2", p_limit: 5 });

    const [first, second] = sendEmail.mock.calls.map(([message]) => message);
    expect(first.text).toContain("9 webhooks were rejected across 2 endpoints");
    expect(first.text).toContain("stripe-prod: 7 rejected webhooks");
    expect(first.text).toContain("gh-staging: 2 rejected webhooks");
    expect(second.text).not.toContain("rejected across");
  });

  it("still sends the generic email when the rejection counts cannot be read", async () => {
    rpc.mockImplementation(async (fn: string) => {
      if (fn === "claim_quota_exhausted_users") return { data: [claimed[0]], error: null };
      if (fn === "get_quota_rejections") return { data: null, error: { message: "stats down" } };
      return { error: null };
    });
    sendEmail.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendQuotaExhaustedEmails()).resolves.toEqual({ sent: 1, failed: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].text).not.toContain("rejected across");
    expect(rpc).toHaveBeenCalledWith("mark_quota_email_sent", { p_user_id: "u1" });
    expect(update).not.toHaveBeenCalled();
  });

  it("sends a paid account the paid copy, with its recurring blocks in the limit", async () => {
    const pro = {
      id: "u3",
      email: "c@example.com",
      plan: "pro",
      request_limit: 100_000,
      block_requests: 25_000,
      period_end: "2026-11-15T06:48:00Z",
      cancel_at_period_end: false,
      team_billed_endpoints: 0,
    };
    rpc.mockImplementation(async (fn: string) =>
      fn === "claim_quota_exhausted_users"
        ? { data: [pro], error: null }
        : { data: [], error: null }
    );
    sendEmail.mockResolvedValue(undefined);

    await expect(sendQuotaExhaustedEmails()).resolves.toEqual({ sent: 1, failed: 0 });
    const [message] = sendEmail.mock.calls[0];
    expect(message.text).toContain("all 125,000 requests in your current Pro billing period");
    expect(message.text).toContain("monthly blocks");
    expect(message.text).not.toContain("Upgrade to Pro");
    expect(rpc).toHaveBeenCalledWith("mark_quota_email_sent", { p_user_id: "u3" });
  });

  it("offers only one-time blocks when the paid plan is ending", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "claim_quota_exhausted_users"
        ? {
            data: [
              {
                id: "u4",
                email: "d@example.com",
                plan: "pro",
                request_limit: 100_000,
                block_requests: 0,
                period_end: "2026-11-15T06:48:00Z",
                cancel_at_period_end: true,
                team_billed_endpoints: 0,
              },
            ],
            error: null,
          }
        : { data: [], error: null }
    );
    sendEmail.mockResolvedValue(undefined);

    await sendQuotaExhaustedEmails();
    const [message] = sendEmail.mock.calls[0];
    expect(message.text).toContain("One-time blocks keep your webhooks coming");
    expect(message.text).not.toContain("monthly blocks");
  });

  it("leaves extra requests out when the add-on products are not configured", async () => {
    getCapacityProductIds.mockReturnValue(null);
    rpc.mockImplementation(async (fn: string) =>
      fn === "claim_quota_exhausted_users"
        ? {
            data: [
              {
                id: "u5",
                email: "e@example.com",
                plan: "pro",
                request_limit: 100_000,
                block_requests: 0,
                period_end: "2026-11-15T06:48:00Z",
                cancel_at_period_end: false,
                team_billed_endpoints: 0,
              },
            ],
            error: null,
          }
        : { data: [], error: null }
    );
    sendEmail.mockResolvedValue(undefined);

    await sendQuotaExhaustedEmails();
    expect(sendEmail.mock.calls[0][0].text).not.toContain("Extra requests");
  });

  it("treats rows without a plan as free, as the function before 00077 returns them", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "claim_quota_exhausted_users"
        ? { data: [claimed[0]], error: null }
        : { data: [], error: null }
    );
    sendEmail.mockResolvedValue(undefined);

    await sendQuotaExhaustedEmails();
    const [message] = sendEmail.mock.calls[0];
    expect(message.text).toContain("all 50 requests in your current free period");
    expect(message.text).toContain("Upgrade to Pro");
  });
});
