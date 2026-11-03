import { describe, expect, it } from "vitest";
import {
  ENTITLEMENTS,
  isPaidPlan,
  isUserPlan,
  planEntitlements,
  planName,
  retentionDays,
  teamAllowance,
  teamEntitlements,
  teamRequestLimit,
} from "./entitlements";

describe("entitlements", () => {
  it("has the decided limits for every plan, field by field", () => {
    // Exact objects: a new field or a changed limit fails here until the
    // decision is written down (and the SQL parity test keeps 00067 in step).
    const common = { poolRequests: 0, quotaPeriod: "month" } as const;
    expect(ENTITLEMENTS.free).toEqual({
      key: "free",
      requestLimit: 50,
      poolRequests: 0,
      quotaPeriod: "day",
      retentionDays: 7,
      parsedPages: 20,
      layoutsPerEndpoint: 2,
      aiAssists: 5,
      customDomains: 0,
      fileDrops: false,
      requestAddons: false,
      pageAddons: false,
      annualBilling: false,
      perSeat: false,
    });
    expect(ENTITLEMENTS.pro).toEqual({
      key: "pro",
      ...common,
      requestLimit: 100_000,
      retentionDays: 31,
      parsedPages: 100,
      layoutsPerEndpoint: 2,
      aiAssists: 20,
      customDomains: 0,
      fileDrops: false,
      requestAddons: true,
      pageAddons: false,
      annualBilling: false,
      perSeat: false,
    });
    expect(ENTITLEMENTS.business).toEqual({
      key: "business",
      ...common,
      requestLimit: 250_000,
      retentionDays: 90,
      parsedPages: 2_000,
      layoutsPerEndpoint: 50,
      aiAssists: 250,
      customDomains: 1,
      fileDrops: true,
      requestAddons: true,
      pageAddons: true,
      annualBilling: true,
      perSeat: false,
    });
    // A Teams team gets Pro's limits: requests per seat, the rest per team.
    expect(ENTITLEMENTS.team).toEqual({
      key: "team",
      ...common,
      requestLimit: 100_000,
      retentionDays: 31,
      parsedPages: 100,
      layoutsPerEndpoint: 2,
      aiAssists: 20,
      customDomains: 0,
      fileDrops: false,
      requestAddons: true,
      pageAddons: false,
      annualBilling: false,
      perSeat: false,
    });
    // Team Business: Business per seat (requests, parsed pages, AI assists),
    // its other limits per team, monthly or annual.
    expect(ENTITLEMENTS.team_business).toEqual({
      key: "team_business",
      requestLimit: 250_000,
      poolRequests: 0,
      quotaPeriod: "month",
      retentionDays: 90,
      parsedPages: 2_000,
      layoutsPerEndpoint: 50,
      aiAssists: 250,
      customDomains: 1,
      fileDrops: true,
      requestAddons: true,
      pageAddons: true,
      annualBilling: true,
      perSeat: true,
    });
    expect(Object.keys(ENTITLEMENTS).sort()).toEqual([
      "business",
      "free",
      "pro",
      "team",
      "team_business",
    ]);
  });

  it("keys every row by its own name", () => {
    for (const [key, row] of Object.entries(ENTITLEMENTS)) expect(row.key).toBe(key);
  });

  it("reads unknown plans as free", () => {
    expect(planEntitlements("enterprise")).toBe(ENTITLEMENTS.free);
    expect(planEntitlements(null)).toBe(ENTITLEMENTS.free);
    expect(planEntitlements("business")).toBe(ENTITLEMENTS.business);
    expect(isUserPlan("business")).toBe(true);
    expect(isUserPlan("team")).toBe(false);
  });

  it("pools team requests by seat, and Team Business pages and assists too", () => {
    expect(teamRequestLimit(3, false)).toBe(300_000);
    expect(teamRequestLimit(3, true)).toBe(750_000);
    expect(teamRequestLimit(0, true)).toBe(0);
    expect(teamEntitlements(true).key).toBe("team_business");
    expect(teamAllowance(3, true)).toEqual({
      requests: 750_000,
      parsedPages: 6_000,
      aiAssists: 750,
    });
    // Teams' pages and assists are the team's, whatever the seats.
    expect(teamAllowance(3, false)).toEqual({ requests: 300_000, parsedPages: 100, aiAssists: 20 });
    // The database counts at least one seat for pages and assists.
    expect(teamAllowance(0, true).parsedPages).toBe(2_000);
  });

  it("names and classifies plans", () => {
    expect(planName("business")).toBe("Business");
    expect(planName("pro")).toBe("Pro");
    expect(planName(undefined)).toBe("Free");
    expect(isPaidPlan("business")).toBe(true);
    expect(isPaidPlan("free")).toBe(false);
  });

  it("keeps a longer retention only while the grace lasts", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    expect(retentionDays("free", null, now)).toBe(7);
    expect(retentionDays("free", { days: 90, until: "2026-11-01T00:00:00Z" }, now)).toBe(90);
    expect(retentionDays("free", { days: 90, until: "2026-10-28T00:00:00Z" }, now)).toBe(7);
    expect(retentionDays("business", { days: 31, until: "2026-11-01T00:00:00Z" }, now)).toBe(90);
  });
});
