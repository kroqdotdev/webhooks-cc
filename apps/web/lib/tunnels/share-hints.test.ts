import { describe, expect, it, vi } from "vitest";
import { ENTITLEMENTS, type PlanKey } from "@/lib/entitlements";

// listing.ts reads the app's URLs at import; the hints need none of them.
vi.mock("@/lib/constants", () => ({ getWebhookUrl: (slug: string) => slug }));

const { shareHints } = await import("./listing");
import type { TunnelPlan } from "./plan";
import type { MonthUsage } from "./usage";

function plan(key: PlanKey, label: string): TunnelPlan {
  return {
    key,
    label,
    limits: ENTITLEMENTS[key],
    notice: key === "free",
    teamId: null,
    teamIds: [],
    activeTeamIds: [],
  };
}

function usage(p: TunnelPlan, over = false): MonthUsage {
  return {
    plan: p,
    month: "2026-11",
    bytes: 0,
    requests: 0,
    allowanceBytes: p.limits.shareDataGb * 1024 ** 3,
    resetsAt: new Date("2026-12-01T00:00:00Z"),
    over,
  };
}

const names = { limit: 0, used: 0, usable: 0 };

describe("shareHints", () => {
  it("gives Free the commands it can run, and what names need", () => {
    const free = plan("free", "Free");
    const hints = shareHints({
      plan: free,
      usage: usage(free),
      suspended: false,
      liveShares: 0,
      names,
    });
    expect(hints.join("\n")).toMatch(/whk share <port>/);
    expect(hints.join("\n")).toMatch(/Reserved names come with Pro and Business/);
    expect(hints.join("\n")).toMatch(/120 minutes/);
    expect(hints.join("\n")).not.toMatch(/--password/);
  });

  it("says how to make room when every slot is in use, and why previews are paused", () => {
    const pro = plan("pro", "Pro");
    const hints = shareHints({
      plan: pro,
      usage: usage(pro, true),
      suspended: false,
      liveShares: 3,
      names: { limit: 3, used: 1, usable: 1 },
    });
    expect(hints[0]).toMatch(/paused/);
    expect(hints.join("\n")).toMatch(/whk shares stop/);
    expect(hints.join("\n")).toMatch(/whk names reserve/);
    expect(hints.join("\n")).toMatch(/--password/);
  });

  it("says only that sharing is suspended when it is", () => {
    const pro = plan("pro", "Pro");
    expect(
      shareHints({ plan: pro, usage: usage(pro), suspended: true, liveShares: 0, names })
    ).toEqual([
      "Sharing is suspended on this account. Write to support@webhooks.cc if this is a mistake.",
    ]);
  });
});
