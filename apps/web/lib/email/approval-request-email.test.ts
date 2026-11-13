import { describe, expect, it } from "vitest";
import { buildApprovalRequestEmail } from "./approval-request-email";

describe("buildApprovalRequestEmail", () => {
  const mail = buildApprovalRequestEmail({
    to: "owner@example.com",
    summary: 'Create an API key named "<b>CI</b>" for 90 days.',
    requester: 'The connected agent "Claude"',
    url: "https://webhooks.cc/approve?code=ABCD-EFGH",
    appUrl: "https://webhooks.cc",
  });

  it("links to the page and never carries the code on its own", () => {
    expect(mail.kind).toBe("approval_request");
    expect(mail.text).toContain("https://webhooks.cc/approve?code=ABCD-EFGH");
    expect(mail.text).toContain("This wasn't me");
    expect(mail.text).toContain("/account/agents");
  });

  it("escapes what an agent chose in the HTML", () => {
    expect(mail.html).toContain("&lt;b&gt;CI&lt;/b&gt;");
    expect(mail.html).not.toContain("<b>CI</b>");
  });
});
