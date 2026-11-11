import { describe, expect, it } from "vitest";
import { ENTITLEMENTS } from "@/lib/entitlements";
import {
  dataText,
  reservedNamesText,
  sessionText,
  shareComparisonRows,
  shareFeatureLines,
  sharesAtOnceText,
} from "./plan-text";

describe("plan text for sharing", () => {
  it("words each limit", () => {
    expect(sharesAtOnceText(3)).toBe("3 at a time");
    expect(reservedNamesText(0)).toBe("Random names only");
    expect(reservedNamesText(1)).toBe("1 name");
    expect(reservedNamesText(20)).toBe("20 names");
    expect(sessionText(null)).toBe("No limit");
    expect(sessionText(60)).toBe("1 hour");
    expect(sessionText(120)).toBe("2 hours");
    expect(sessionText(90)).toBe("90 minutes");
    expect(dataText(25)).toBe("25 GB a month");
  });

  it("reads the comparison rows from the entitlements", () => {
    const rows = shareComparisonRows();
    expect(rows).toHaveLength(5);
    const data = rows.find((r) => r.label === "Preview data")!;
    expect(data.free).toBe(dataText(ENTITLEMENTS.free.shareDataGb));
    expect(data.business).toBe(dataText(ENTITLEMENTS.business.shareDataGb));
    const passwords = rows.find((r) => r.label === "Passwords on previews")!;
    expect(passwords.free).toBe(ENTITLEMENTS.free.sharePasswords ? "Yes" : "No");
    expect(passwords.pro).toBe(ENTITLEMENTS.pro.sharePasswords ? "Yes" : "No");
  });

  it("gives every plan a pricing line", () => {
    for (const plan of ["free", "pro", "business"] as const) {
      const lines = shareFeatureLines(plan);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join(" ")).toContain(String(ENTITLEMENTS[plan].shareSlots));
    }
  });
});
