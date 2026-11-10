import { describe, expect, it } from "vitest";
import { securityTxt } from "./security-txt";

describe("securityTxt", () => {
  it("lists the contacts and an expiry under a year ahead", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const body = securityTxt(now, "https://webhooks.cc", true);
    expect(body).toContain("Contact: mailto:support@webhooks.cc\n");
    expect(body).toContain("Contact: https://webhooks.cc/report\n");
    expect(body).toContain("Expires: 2027-05-09T12:00:00Z\n");
    expect(body).toContain("Canonical: https://webhooks.cc/.well-known/security.txt\n");
  });

  it("lists the report form only while sharing is on", () => {
    const body = securityTxt(Date.now(), "https://webhooks.cc", false);
    expect(body).toContain("Contact: mailto:support@webhooks.cc\n");
    expect(body).not.toContain("/report");
  });
});
