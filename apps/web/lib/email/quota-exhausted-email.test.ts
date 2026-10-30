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

  describe("paid accounts", () => {
    const pro = {
      to: "dev@example.com",
      requestLimit: 125_000,
      periodEnd: new Date("2026-11-15T06:48:00Z"),
      teamBilledEndpoints: 0,
      plan: "pro",
      extraRequestsOffered: true,
      appUrl: "https://webhooks.cc",
    };

    it("names the billing period and when it renews, without the upgrade pitch", () => {
      const email = buildQuotaExhaustedEmail(pro);
      expect(email.text).toContain("all 125,000 requests in your current Pro billing period");
      expect(email.text).toContain("Until the period renews at 2026-11-15 06:48 UTC");
      for (const body of [email.text, email.html]) {
        expect(body).not.toContain("Upgrade to Pro");
        expect(body).not.toContain("free period");
        expect(body).not.toContain("https://webhooks.cc/teams");
      }
    });

    it("offers every kind of extra request on a renewing plan", () => {
      const email = buildQuotaExhaustedEmail(pro);
      for (const body of [email.text, email.html]) {
        expect(body).toContain("monthly blocks");
        expect(body).toContain("($2 a month, renewed with your plan)");
        expect(body).toContain("one-time blocks ($3, kept until used)");
        expect(body).toContain("overage ($4 per 25,000 used");
      }
      expect(email.text).toContain("https://webhooks.cc/account/plan#extra-requests");
      expect(email.html).toContain('href="https://webhooks.cc/account/plan#extra-requests"');
    });

    it("offers only one-time blocks when the plan is set to end", () => {
      const email = buildQuotaExhaustedEmail({ ...pro, planEnding: true });
      expect(email.text).toContain(
        "For the rest of the period, which ends at 2026-11-15 06:48 UTC"
      );
      expect(email.text).not.toContain("renews");
      for (const body of [email.text, email.html]) {
        expect(body).toContain("One-time blocks keep your webhooks coming: 25,000 requests");
        expect(body).not.toContain("monthly blocks");
        expect(body).not.toContain("overage");
      }
    });

    it("points to the plan page when extra requests are not offered", () => {
      const email = buildQuotaExhaustedEmail({ ...pro, extraRequestsOffered: false });
      expect(email.text).not.toContain("Extra requests");
      expect(email.text).toContain("Your usage this period is on your plan page:");
      expect(email.text).toContain("https://webhooks.cc/account/plan\n");
    });

    it("promises at most one email per billing period", () => {
      const email = buildQuotaExhaustedEmail(pro);
      expect(email.text).toContain("at most once per billing period");
      expect(email.text).not.toContain("once a week");
    });

    it("lists rejected webhooks before the extra requests", () => {
      const email = buildQuotaExhaustedEmail({
        ...pro,
        rejections: { total: 5, endpointCount: 1, endpoints: [{ slug: "a", rejected: 5 }] },
      });
      expect(email.text.indexOf("  a: 5 rejected webhooks")).toBeLessThan(
        email.text.indexOf("Extra requests")
      );
    });

    it("leaves the free copy alone when the plan is free", () => {
      const free = buildQuotaExhaustedEmail({
        to: "dev@example.com",
        requestLimit: 50,
        periodEnd: new Date("2026-09-29T18:30:00Z"),
        teamBilledEndpoints: 0,
        plan: "free",
        planEnding: true,
        extraRequestsOffered: true,
        appUrl: "https://webhooks.cc",
      });
      expect(free).toEqual(message);
    });
  });
});
