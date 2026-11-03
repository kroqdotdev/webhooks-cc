import { describe, expect, it } from "vitest";
import {
  buildClosedEmail,
  buildReminderEmail,
  buildReplyEmail,
  buildStaffAlert,
  headerText,
} from "./emails";

const ticket = { number: 1042, subject: "Stripe <b>fails</b>\r\nBcc: x@example.com" };

describe("support emails", () => {
  it("keeps the subject on one line", () => {
    expect(headerText("a\r\nBcc: b")).toBe("a Bcc: b");
    expect(headerText("x".repeat(300)).length).toBe(120);
  });

  it("sends the staff reply in full, escaped, and marks itself automatic", () => {
    const email = buildReplyEmail({
      to: "jordan@acme.example",
      ticket,
      replies: [{ author: "Mads from support", body: "Paste the <secret> again.\n\nThen retry." }],
      link: "https://webhooks.cc/support/1042",
    });
    // Fixed text: the subject the user wrote never goes out from our domain.
    expect(email.subject).toBe("[#1042] Support replied to your ticket");
    expect(email.text).not.toContain("Stripe <b>");
    expect(email.text).toContain("Paste the <secret> again.");
    expect(email.html).toContain("Paste the &lt;secret&gt; again.");
    expect(email.html).not.toContain("<secret>");
    expect(email.headers?.["Auto-Submitted"]).toBe("auto-generated");
  });

  it("offers ratings and the reopen window on close", () => {
    const email = buildClosedEmail({
      to: "jordan@acme.example",
      ticket,
      replies: [],
      link: "https://webhooks.cc/support/1042",
      auto: true,
    });
    expect(email.text).toContain("closed after 7 days without an answer");
    expect(email.text).toContain("https://webhooks.cc/support/1042?rate=5");
    expect(email.text).toContain("within 30 days");
  });

  it("names the close date in the reminder", () => {
    const email = buildReminderEmail({
      to: "jordan@acme.example",
      ticket,
      link: "https://webhooks.cc/support/1042",
      closesAt: new Date("2026-11-10T12:00:00Z"),
    });
    expect(email.text).toContain("Nov 10");
  });

  it("tells staff nothing the user wrote", () => {
    const email = buildStaffAlert({
      to: "support@webhooks.cc",
      kind: "staff_new",
      number: 1042,
      category: "billing",
      plan: "business",
      blocking: true,
      link: "https://webhooks.cc/ops/tickets/1042",
    });
    expect(email.subject).toBe("New ticket #1042 (Billing, blocking)");
    expect(email.text).not.toContain("Stripe");
    expect(email.html).not.toContain("Stripe");
    expect(email.text).toContain("Business");
  });
});
