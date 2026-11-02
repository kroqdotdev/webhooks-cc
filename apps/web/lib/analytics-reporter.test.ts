import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { dailyAccountEvents, duePeriods } = await import("./analytics-reporter");

describe("duePeriods", () => {
  it("lists finished hours, oldest first, once they have settled", () => {
    const hours = duePeriods(new Date("2026-11-02T14:05:00Z"), "signups");
    expect(hours).toHaveLength(48);
    // 13:00 to 14:00 ended five minutes ago, inside the settling time.
    expect(hours.at(-1)?.toISOString()).toBe("2026-11-02T12:00:00.000Z");
    expect(hours[0].toISOString()).toBe("2026-10-31T13:00:00.000Z");
    expect(duePeriods(new Date("2026-11-02T14:15:00Z"), "signups").at(-1)?.toISOString()).toBe(
      "2026-11-02T13:00:00.000Z"
    );
  });

  it("lists the last three finished days", () => {
    expect(
      duePeriods(new Date("2026-11-02T00:20:00Z"), "daily_usage").map((d) => d.toISOString())
    ).toEqual(["2026-10-30T00:00:00.000Z", "2026-10-31T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
  });
});

describe("dailyAccountEvents", () => {
  const row = {
    user_id: "user-1",
    plan: "pro",
    billing_interval: "month",
    subscription_status: "active",
    home_site: "webhooks",
    signed_up_at: "2026-10-01T10:00:00Z",
    request_limit: 100000,
    requests_used: 1200,
    overage_active: false,
    captured: 40,
    quota_rejected: 0,
    bytes: 52000,
    endpoints_with_traffic: 2,
    first_capture: false,
    audited_actions: 3,
    endpoints_count: 4,
    email_endpoints_count: 1,
    layout_endpoints_count: 0,
    destinations_count: 2,
    verified_domains_count: 0,
    api_keys_count: 1,
    connected_agents_count: 1,
    teams_count: 0,
  };

  it("reports the day's usage at its end and brings the person up to date", () => {
    const [usage, ...rest] = dailyAccountEvents("2026-11-01", row);
    expect(rest).toEqual([]);
    expect(usage.event).toBe("usage_daily");
    expect(usage.timestamp?.toISOString()).toBe("2026-11-01T23:59:59.000Z");
    expect(usage.properties).toMatchObject({ day: "2026-11-01", captured: 40 });
    expect(usage.set).toMatchObject({ plan: "pro", destinations_count: 2 });
  });

  it("adds the first capture once, with an id of its own", () => {
    const events = dailyAccountEvents("2026-11-01", { ...row, first_capture: true });
    expect(events.map((e) => e.event)).toEqual(["usage_daily", "first_request_captured"]);
    expect(events[1].uuid).not.toBe(events[0].uuid);
  });

  it("reads bigint counts that arrive as strings", () => {
    const [usage] = dailyAccountEvents("2026-11-01", {
      ...row,
      captured: "12" as unknown as number,
    });
    expect(usage.properties?.captured).toBe(12);
  });
});
