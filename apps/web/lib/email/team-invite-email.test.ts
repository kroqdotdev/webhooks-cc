import { describe, expect, it } from "vitest";
import { buildTeamInviteEmail } from "./team-invite-email";

describe("buildTeamInviteEmail", () => {
  const base = {
    inviterEmail: "owner@example.com",
    teamName: "Acme",
    invitedEmail: "new@example.com",
    appUrl: "https://webhooks.cc",
  };

  it("addresses the invited email and names inviter + team in the subject", () => {
    const message = buildTeamInviteEmail(base);
    expect(message.to).toBe("new@example.com");
    expect(message.subject).toBe("owner@example.com invited you to Acme on webhooks.cc");
  });

  it("links to the teams page in both text and html", () => {
    const message = buildTeamInviteEmail(base);
    expect(message.text).toContain("https://webhooks.cc/teams");
    expect(message.html).toContain('href="https://webhooks.cc/teams"');
  });

  it("tells the invitee to sign up with the invited address", () => {
    const message = buildTeamInviteEmail(base);
    expect(message.text).toContain("new@example.com");
  });

  it("escapes user-controlled values in the html variant", () => {
    const message = buildTeamInviteEmail({
      ...base,
      teamName: '<script>alert("x")</script>',
    });
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
  });
});
