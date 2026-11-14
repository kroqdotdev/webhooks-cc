import { describe, expect, it } from "vitest";
import { alertDestinationFormat, alertEmail, alertFixPrompt, describeAlert } from "./notify";

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

  it("says when no layout matched", () => {
    const { summary, lines } = describeAlert(
      {
        kind: "fields",
        subject: null,
        resolved_at: null,
        details: { missing: ["(no layout matched)"], streak: 2 },
      },
      "Orders",
      null
    );
    expect(summary).toBe("Orders: no layout matched");
    expect(lines[0]).toBe("2 emails in a row matched no layout.");
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

describe("failed-delivery alert email", () => {
  const event = {
    kind: "destination",
    subject: "dest-1",
    resolved_at: null,
    details: {
      failed: 3,
      lastError: "HTTP 500 from acme-orders.example.com",
      lastFailedAt: "2026-11-14T10:00:00Z",
      lastDeliveryId: "6f1c2a4e-8b3d-4c5e-9f00-1a2b3c4d5e6f",
      lastRequestId: "0d9e8f7a-6b5c-4d3e-8f21-a0b1c2d3e4f5",
      lastStatus: 500,
    },
  } as const;
  const { summary, lines } = describeAlert(event, "Orders", "ERP");
  const link = "https://webhooks.cc/dashboard?endpoint=acme-orders";

  it("has no T3 Code link without an agent repository", () => {
    const fix = alertFixPrompt(event, null, "json");
    expect(fix).toBeNull();
    const email = alertEmail(event, summary, lines, link, fix);
    expect(email.subject).toBe("Alert: Orders: deliveries to ERP are failing");
    expect(email.text).not.toContain("t3.codes");
    expect(email.text).not.toContain("coding agent");
  });

  it("links to T3 Code with the prompt when the endpoint names its repository", () => {
    const fix = alertFixPrompt(event, "acme/api", "as_received");
    expect(fix).not.toBeNull();
    const email = alertEmail(event, summary, lines, link, fix);
    expect(email.text).toContain(
      "Hand it to a coding agent in T3 Code: https://app.t3.codes/new?prompt="
    );
    expect(email.text).toContain("&repo=acme/api");
    expect(email.text).toContain(
      "A webhooks.cc delivery failed with status 500. Using the webhooks.cc MCP server or `whk`, read delivery 6f1c2a4e-8b3d-4c5e-9f00-1a2b3c4d5e6f of request 0d9e8f7a-6b5c-4d3e-8f21-a0b1c2d3e4f5"
    );
    // The link carries ids and the status only, never the slug, host or error.
    const t3 = email.text.split("\n").find((line) => line.includes("app.t3.codes"))!;
    expect(t3).not.toContain("acme-orders");
    expect(t3).not.toContain("example.com");
    expect(t3).not.toContain("ERP");
    expect(email.text.endsWith("Change them in its settings.\n")).toBe(true);
  });

  it("leaves the link off resolved alerts, other kinds, chat, Sheets, drops and deleted requests", () => {
    expect(alertFixPrompt({ ...event, resolved_at: "2026-11-14" }, "acme/api", "json")).toBeNull();
    expect(alertFixPrompt({ ...event, kind: "silence" }, "acme/api", "json")).toBeNull();
    for (const format of ["chat", "sheets", "file_drop"]) {
      expect(alertFixPrompt(event, "acme/api", format)).toBeNull();
    }
    // An automatic format (stored null) is chat for a Slack or Discord URL.
    for (const url of [
      "https://hooks.slack.com/services/T/B/X",
      "https://discord.com/api/webhooks/123/abc",
    ]) {
      expect(alertFixPrompt(event, "acme/api", alertDestinationFormat(null, url))).toBeNull();
    }
    expect(
      alertFixPrompt(
        event,
        "acme/api",
        alertDestinationFormat(null, "https://api.acme.example/hooks")
      )
    ).not.toBeNull();
    expect(alertDestinationFormat("json", "https://hooks.slack.com/services/T/B/X")).toBe("json");
    // Requests deleted once delivered take their deliveries with them minutes
    // after the failure, so the prompt's ids would name nothing.
    expect(alertFixPrompt(event, "acme/api", "json", true)).toBeNull();
    expect(alertFixPrompt(event, "acme/api", "json", false)).not.toBeNull();
    // An alert opened before the ids were recorded has nothing to name.
    expect(
      alertFixPrompt({ ...event, details: { failed: 1, lastError: "x" } }, "acme/api", "json")
    ).toBeNull();
  });
});
