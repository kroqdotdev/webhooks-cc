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

const { sendWelcomeEmails } = await import("./welcome-emails");

const claimed = [
  { id: "u1", email: "a@example.com", home_site: "webhooks" },
  { id: "u2", email: "b@example.com", home_site: "mailhooks" },
];

function claimReturns(rows: unknown) {
  rpc.mockImplementation(async (fn: string) =>
    fn === "claim_welcome_email_users" ? { data: rows, error: null } : { error: null }
  );
}

describe("sendWelcomeEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://webhooks.cc");
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "https://mailhooks.cc");
    eq.mockResolvedValue({ error: null });
    sendEmail.mockResolvedValue(undefined);
  });

  it("emails every claimed account on its own site and marks each one sent", async () => {
    claimReturns(claimed);

    await expect(sendWelcomeEmails()).resolves.toEqual({ sent: 2, failed: 0 });
    expect(rpc).toHaveBeenCalledWith("claim_welcome_email_users", { p_limit: 50 });
    const [first, second] = sendEmail.mock.calls.map(([message]) => message);
    expect(first.to).toBe("a@example.com");
    expect(first.subject).toBe("Getting started with webhooks.cc");
    expect(first.text).toContain("https://webhooks.cc/dashboard");
    expect(second.to).toBe("b@example.com");
    expect(second.subject).toBe("Getting started with mailhooks.cc");
    expect(second.text).toContain("https://mailhooks.cc/dashboard");
    expect(rpc).toHaveBeenCalledWith("mark_welcome_email_sent", { p_user_id: "u1" });
    expect(rpc).toHaveBeenCalledWith("mark_welcome_email_sent", { p_user_id: "u2" });
    expect(update).not.toHaveBeenCalled();
  });

  it("sends the webhooks.cc copy to everyone when the app serves one site", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "");
    claimReturns([claimed[1]]);

    await sendWelcomeEmails();
    const message = sendEmail.mock.calls[0][0];
    expect(message.subject).toBe("Getting started with webhooks.cc");
    expect(message.text).toContain("https://webhooks.cc/dashboard");
  });

  it("records each account before sending, so a failure after the send cannot repeat it", async () => {
    claimReturns([claimed[0]]);
    const order: string[] = [];
    rpc.mockImplementation(async (fn: string) => {
      order.push(fn);
      return fn === "claim_welcome_email_users"
        ? { data: [claimed[0]], error: null }
        : { error: null };
    });
    sendEmail.mockImplementation(async () => {
      order.push("send");
    });

    await sendWelcomeEmails();
    expect(order).toEqual(["claim_welcome_email_users", "mark_welcome_email_sent", "send"]);
  });

  it("clears the record and the lease when a send fails, so a later poll retries", async () => {
    claimReturns(claimed);
    sendEmail.mockRejectedValueOnce(new Error("smtp down")).mockResolvedValueOnce(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendWelcomeEmails()).resolves.toEqual({ sent: 1, failed: 1 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      welcome_email_sent_at: null,
      welcome_email_claimed_at: null,
    });
    expect(eq).toHaveBeenCalledWith("id", "u1");
  });

  it("skips an account it could not record, without sending", async () => {
    rpc.mockImplementation(async (fn: string, args?: { p_user_id?: string }) => {
      if (fn === "claim_welcome_email_users") return { data: claimed, error: null };
      return args?.p_user_id === "u1" ? { error: { message: "blip" } } : { error: null };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendWelcomeEmails()).resolves.toEqual({ sent: 1, failed: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe("b@example.com");
    expect(update).not.toHaveBeenCalled();
  });

  it("throws when the claim fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(sendWelcomeEmails()).rejects.toThrow("claim_welcome_email_users failed: boom");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does nothing when no account is due", async () => {
    claimReturns([]);
    await expect(sendWelcomeEmails()).resolves.toEqual({ sent: 0, failed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
