import { describe, expect, it } from "vitest";
import {
  ENTITLEMENTS,
  isPaidPlan,
  isUserPlan,
  planEntitlements,
  planName,
  retentionDays,
  teamEntitlements,
  teamRequestLimit,
} from "./entitlements";

describe("entitlements", () => {
  it("has the decided limits for every plan", () => {
    expect(ENTITLEMENTS.free).toMatchObject({
      requestLimit: 50,
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
    });
    expect(ENTITLEMENTS.pro).toMatchObject({
      requestLimit: 100_000,
      quotaPeriod: "month",
      retentionDays: 31,
      parsedPages: 100,
      layoutsPerEndpoint: 2,
      aiAssists: 20,
      customDomains: 0,
      fileDrops: false,
      requestAddons: true,
      pageAddons: false,
      annualBilling: false,
    });
    expect(ENTITLEMENTS.business).toMatchObject({
      requestLimit: 250_000,
      retentionDays: 90,
      parsedPages: 2_000,
      layoutsPerEndpoint: 50,
      aiAssists: 500,
      customDomains: 1,
      fileDrops: true,
      requestAddons: true,
      pageAddons: true,
      annualBilling: true,
    });
    expect(ENTITLEMENTS.team).toMatchObject({ requestLimit: 100_000, retentionDays: 31 });
    expect(ENTITLEMENTS.team_business).toMatchObject({
      requestLimit: 100_000,
      poolRequests: 150_000,
      retentionDays: 90,
      parsedPages: 2_000,
      customDomains: 1,
      fileDrops: true,
      pageAddons: true,
      annualBilling: false,
    });
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

  it("pools team requests by seat, plus the add-on's pool", () => {
    expect(teamRequestLimit(3, false)).toBe(300_000);
    expect(teamRequestLimit(3, true)).toBe(450_000);
    expect(teamRequestLimit(0, true)).toBe(150_000);
    expect(teamEntitlements(true).key).toBe("team_business");
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
