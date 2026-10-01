import { describe, expect, it } from "vitest";
import { buildQuotaExhaustedEmail } from "./quota-exhausted-email";

describe("buildQuotaExhaustedEmail", () => {
  const message = buildQuotaExhaustedEmail({
    to: "dev@example.com",
    requestLimit: 50,
    periodEnd: new Date("2026-09-29T18:30:00Z"),
    teamBilledEndpoints: 0,
    appUrl: "https://webhooks.cc",
  });

  it("addresses the user and names the reset time in UTC", () => {
    expect(message.to).toBe("dev@example.com");
    expect(message.text).toContain("all 50 requests");
    expect(message.text).toContain("2026-09-29 18:30 UTC");
    expect(message.html).toContain("2026-09-29 18:30 UTC");
  });

  it("names team-shared endpoints as unaffected only when there are any", () => {
    expect(message.text).not.toContain("team's quota");
    const withTeam = buildQuotaExhaustedEmail({
      to: "dev@example.com",
      requestLimit: 50,
      periodEnd: new Date("2026-09-29T18:30:00Z"),
      teamBilledEndpoints: 2,
      appUrl: "https://webhooks.cc",
    });
    expect(withTeam.text).toContain("Endpoints shared with a team use the team's quota");
    expect(withTeam.html).toContain("Endpoints shared with a team use the team's quota");
  });

  it("links to the upgrade and team pages", () => {
    expect(message.text).toContain("https://webhooks.cc/account");
    expect(message.text).toContain("https://webhooks.cc/teams");
    expect(message.html).toContain('href="https://webhooks.cc/account"');
    expect(message.html).toContain('href="https://webhooks.cc/teams"');
  });
});
