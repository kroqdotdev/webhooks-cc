import { describe, expect, it } from "vitest";
import { addDays, buildLines, shapeLast24h, utcDay } from "./metrics";
import type { Database } from "@/lib/supabase/database";

type Row = Database["public"]["Tables"]["ops_daily_metrics"]["Row"];

function row(day: string, values: Partial<Row>): Row {
  return {
    day,
    signups: 0,
    cohort_signups: null,
    cohort_activated: null,
    active_accounts: 0,
    captured: 0,
    quota_rejected: 0,
    paid_accounts: null,
    new_paid: null,
    lost_paid: null,
    mrr_cents: null,
    new_subscriptions: null,
    canceled_subscriptions: null,
    computed_at: "2026-11-03T00:10:00Z",
    ...values,
  };
}

describe("ops metrics", () => {
  it("counts UTC days", () => {
    expect(utcDay(new Date("2026-11-03T23:59:00Z"))).toBe("2026-11-03");
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
  });

  it("compares the last 7 days with the 7 before", () => {
    const yesterday = "2026-11-02";
    const rows: Row[] = [];
    for (let i = 0; i < 28; i++) {
      const day = addDays(yesterday, -i);
      rows.push(row(day, { signups: i < 7 ? 20 : 10, mrr_cents: 100_000 + (27 - i) * 100 }));
    }
    const lines = buildLines(rows, yesterday);
    const signups = lines.find((line) => line.key === "signups")!;
    expect(signups.yesterday).toBe(20);
    expect(signups.avg7).toBe(20);
    expect(signups.prev7).toBe(10);
    expect(signups.series).toHaveLength(28);
    const mrr = lines.find((line) => line.key === "mrr")!;
    // A level: the last value of each week, not an average.
    expect(mrr.avg7).toBe(102_700);
    expect(mrr.prev7).toBe(102_000);
  });

  it("leaves days without a row empty", () => {
    const lines = buildLines([row("2026-11-02", { signups: 3 })], "2026-11-02");
    const signups = lines.find((line) => line.key === "signups")!;
    expect(signups.series.filter((value) => value !== null)).toEqual([3]);
    expect(signups.prev7).toBeNull();
  });

  it("works out activation from the cohort", () => {
    const lines = buildLines(
      [row("2026-11-02", { cohort_signups: 10, cohort_activated: 4 })],
      "2026-11-02"
    );
    expect(lines.find((line) => line.key === "activated")!.yesterday).toBe(0.4);
  });

  it("puts the last 24 hours beside each line", () => {
    const last = shapeLast24h({
      snapshot_at: "2026-11-02T13:10:00Z",
      signups: 4,
      cohort_signups: 5,
      cohort_activated: 2,
      active_accounts: 7,
      captured: 1200,
      quota_rejected: 3,
      paid_accounts: 9,
      new_paid: 1,
      lost_paid: 0,
    });
    const lines = buildLines([row("2026-11-02", { signups: 3 })], "2026-11-02", last);
    const value = (key: string) => lines.find((line) => line.key === key)!.last24h;
    expect(value("signups")).toBe(4);
    expect(value("activated")).toBe(0.4);
    expect(value("active")).toBe(7);
    expect(value("captured")).toBe(1200);
    expect(value("rejected")).toBe(3);
    expect(value("paid")).toBe(9);
    expect(value("new_paid")).toBe(1);
    expect(value("lost_paid")).toBe(0);
    // Polar's daily figures have no 24-hour value.
    expect(value("mrr")).toBeNull();
    expect(value("new_subs")).toBeNull();
    expect(value("canceled_subs")).toBeNull();
    // The day's own columns are untouched.
    expect(lines.find((line) => line.key === "signups")!.yesterday).toBe(3);
  });

  it("shows a dash for snapshot-based values until a snapshot exists", () => {
    const last = shapeLast24h({
      snapshot_at: null,
      signups: 2,
      cohort_signups: 0,
      cohort_activated: 0,
      // A stray value without a snapshot is never shown.
      active_accounts: 5,
      captured: null,
      quota_rejected: null,
      paid_accounts: 6,
      new_paid: null,
      lost_paid: null,
    })!;
    expect(last.since).toBeNull();
    const lines = buildLines([], "2026-11-02", last);
    const value = (key: string) => lines.find((line) => line.key === key)!.last24h;
    expect(value("signups")).toBe(2);
    expect(value("paid")).toBe(6);
    // No cohort: no share rather than 0%.
    expect(value("activated")).toBeNull();
    for (const key of ["active", "captured", "rejected", "new_paid", "lost_paid"]) {
      expect(value(key)).toBeNull();
    }
  });

  it("reads bigint counts that arrive as strings, and no row as nothing", () => {
    const last = shapeLast24h({
      snapshot_at: "2026-11-02T13:10:00Z",
      signups: "12" as unknown as number,
      cohort_signups: 0,
      cohort_activated: 0,
      active_accounts: 1,
      captured: "9007199254740993" as unknown as number,
      quota_rejected: 0,
      paid_accounts: 0,
      new_paid: 0,
      lost_paid: 0,
    })!;
    expect(last.signups).toBe(12);
    expect(last.captured).toBeGreaterThan(9e15);
    expect(shapeLast24h(undefined)).toBeNull();
    const lines = buildLines([], "2026-11-02", null);
    expect(lines.every((line) => line.last24h === null)).toBe(true);
  });
});
