import { describe, expect, it } from "vitest";
import { describeAlert } from "./notify";

describe("alert wording", () => {
  it("names the missing fields and what to do", () => {
    const { summary, lines } = describeAlert(
      {
        kind: "fields",
        subject: null,
        resolved_at: null,
        details: { missing: ["order"], streak: 3 },
      },
      "Orders",
      null
    );
    expect(summary).toBe("Orders: order stopped matching");
    expect(lines[0]).toBe("3 emails in a row missed order.");
    expect(lines.join(" ")).toContain("replay");
  });

  it("words silence and destination alerts, open and resolved", () => {
    expect(
      describeAlert(
        { kind: "silence", subject: null, resolved_at: null, details: { hours: 1 } },
        "E",
        null
      ).summary
    ).toBe("E: no email for 1 hour");
    expect(
      describeAlert(
        {
          kind: "destination",
          subject: "d",
          resolved_at: null,
          details: { failed: 2, lastError: "500" },
        },
        "E",
        "ERP"
      ).lines
    ).toContain("Last error: 500");
    expect(
      describeAlert(
        { kind: "destination", subject: "d", resolved_at: "2026-10-29", details: {} },
        "E",
        "ERP"
      ).summary
    ).toBe("E: ERP is receiving deliveries again");
  });
});
