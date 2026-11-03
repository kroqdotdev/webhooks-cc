import { describe, expect, it } from "vitest";
import { addDays, buildLines, utcDay } from "./metrics";
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
});
