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
    expect(message.text).toContain("https://webhooks.cc/account/plan");
    expect(message.text).toContain("https://webhooks.cc/teams");
    expect(message.html).toContain('href="https://webhooks.cc/account/plan"');
    expect(message.html).toContain('href="https://webhooks.cc/teams"');
  });
  describe("rejected webhooks", () => {
    const base = {
      to: "dev@example.com",
      requestLimit: 50,
      periodEnd: new Date("2026-09-29T18:30:00Z"),
      teamBilledEndpoints: 0,
      appUrl: "https://webhooks.cc",
    };

    it("keeps the generic copy when nothing has been rejected yet", () => {
      for (const rejections of [undefined, null, { total: 0, endpointCount: 0, endpoints: [] }]) {
        const email = buildQuotaExhaustedEmail({ ...base, rejections });
        expect(email.text).toBe(message.text);
        expect(email.html).toBe(message.html);
      }
    });

    it("lists the total and each affected endpoint", () => {
      const email = buildQuotaExhaustedEmail({
        ...base,
        rejections: {
          total: 1420,
          endpointCount: 2,
          endpoints: [
            { slug: "stripe-prod", rejected: 1000 },
            { slug: "gh-staging", rejected: 420 },
          ],
        },
      });
      expect(email.text).toContain(
        "So far in this period 1,420 webhooks were rejected across 2 endpoints:"
      );
      expect(email.text).toContain("  stripe-prod: 1,000 rejected webhooks");
      expect(email.text).toContain("  gh-staging: 420 rejected webhooks");
      expect(email.text).not.toContain("more endpoint");
      expect(email.html).toContain("<li><code>stripe-prod</code>: 1,000 rejected webhooks</li>");
      expect(email.html).toContain("<li><code>gh-staging</code>: 420 rejected webhooks</li>");
    });

    it("uses singular wording for one webhook on one endpoint", () => {
      const email = buildQuotaExhaustedEmail({
        ...base,
        rejections: { total: 1, endpointCount: 1, endpoints: [{ slug: "solo", rejected: 1 }] },
      });
      expect(email.text).toContain("1 webhook was rejected across 1 endpoint:");
      expect(email.text).toContain("  solo: 1 rejected webhook");
      expect(email.text).not.toContain("1 rejected webhooks");
    });

    it("summarizes endpoints beyond the listed ones", () => {
      const email = buildQuotaExhaustedEmail({
        ...base,
        rejections: {
          total: 900,
          endpointCount: 4,
          endpoints: [
            { slug: "a", rejected: 500 },
            { slug: "b", rejected: 300 },
          ],
        },
      });
      expect(email.text).toContain("  and 2 more endpoints");
      expect(email.html).toContain("<li>and 2 more endpoints</li>");
    });

    it("places the rejection list before the upgrade call to action", () => {
      const email = buildQuotaExhaustedEmail({
        ...base,
        rejections: { total: 5, endpointCount: 1, endpoints: [{ slug: "a", rejected: 5 }] },
      });
      expect(email.text.indexOf("  a: 5 rejected webhooks")).toBeLessThan(
        email.text.indexOf("Upgrade to Pro")
      );
    });

    it("escapes slugs in the HTML variant", () => {
      const email = buildQuotaExhaustedEmail({
        ...base,
        rejections: {
          total: 2,
          endpointCount: 1,
          endpoints: [{ slug: `<img src=x onerror="alert(1)">`, rejected: 2 }],
        },
      });
      expect(email.html).not.toContain("<img");
      expect(email.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    });
  });
});
