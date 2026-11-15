import { beforeEach, describe, expect, test, vi } from "vitest";

const sent: { to: string; kind: string; subject: string; text: string; html?: string }[] = [];
let failSend = false;
vi.mock("@/lib/email/mailer", () => ({
  sendEmail: vi.fn(async (message: (typeof sent)[number]) => {
    if (failSend) throw new Error("smtp down");
    sent.push(message);
  }),
}));
const reported: string[] = [];
vi.mock("@/lib/observability", () => ({
  reportError: (message: string) => reported.push(message),
}));
vi.mock("@/lib/site", () => ({
  siteOrigin: (site: string) =>
    site === "mailhooks" ? "https://mailhooks.cc" : "https://webhooks.cc",
}));
const rows: Record<string, Record<string, unknown> | null> = {};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: rows[table] ?? null, error: null }) }),
      }),
    }),
  }),
}));

const { buildConnectBoundEmail, notifyConnectBound } = await import("./org-connect-notice");

beforeEach(() => {
  sent.length = 0;
  reported.length = 0;
  failSend = false;
  rows.users = { email: "ada@acme.test", home_site: "webhooks" };
  rows.teams = { name: "Acme <Platform>" };
});

describe("buildConnectBoundEmail", () => {
  test("says what connected, when and through which issuer, and links the team page", () => {
    const message = buildConnectBoundEmail({
      to: "ada@acme.test",
      teamName: "Acme <Platform>",
      clientName: "claude.ai",
      issuer: "https://identity.example.com/issuers/org-1",
      connectedAt: new Date("2026-11-15T10:20:30Z"),
      teamUrl: "https://webhooks.cc/teams/t-1#agent-sign-in",
    });
    expect(message).toMatchObject({
      to: "ada@acme.test",
      kind: "team_idjag_connect_bound",
      headers: { "Auto-Submitted": "auto-generated" },
    });
    expect(message.text).toContain(
      "claude.ai connected to your webhooks.cc account at 2026-11-15 10:20 UTC"
    );
    expect(message.text).toContain("https://identity.example.com/issuers/org-1");
    expect(message.text).toContain("https://webhooks.cc/teams/t-1#agent-sign-in");
    // Names chosen by people and agents are escaped in the HTML part.
    expect(message.html).toContain("Acme &lt;Platform&gt;");
    expect(message.html).not.toContain("<Platform>");
    expect(message.html).toContain('href="https://webhooks.cc/teams/t-1#agent-sign-in"');
  });
});

describe("notifyConnectBound", () => {
  test("emails the member, linking the team page on their home site", async () => {
    rows.users = { email: "ada@acme.test", home_site: "mailhooks" };
    await notifyConnectBound({
      userId: "u-1",
      teamId: "t-1",
      clientName: "claude.ai",
      issuer: "https://identity.example.com/issuers/org-1",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ada@acme.test");
    expect(sent[0].text).toContain("https://mailhooks.cc/teams/t-1#agent-sign-in");
    expect(sent[0].text).toContain("Acme <Platform>");
  });

  test("reports a failed send and never throws", async () => {
    failSend = true;
    await expect(
      notifyConnectBound({ userId: "u-1", teamId: "t-1", clientName: null, issuer: "https://x" })
    ).resolves.toBeUndefined();
    expect(reported).toEqual(["[agent] connect-bound notice failed"]);
  });

  test("sends nothing for an account without an email", async () => {
    rows.users = null;
    await notifyConnectBound({
      userId: "u-1",
      teamId: "t-1",
      clientName: null,
      issuer: "https://x",
    });
    expect(sent).toEqual([]);
  });
});
