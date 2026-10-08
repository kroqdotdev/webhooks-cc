import { describe, expect, it } from "vitest";
import { extractFromEmail } from "./email-extract";
import { buildTestEmail, signMailRequest, testDeliveryBody, TEST_EMAIL_HEADER } from "./test-email";

describe("signMailRequest", () => {
  it("signs exactly like the MX host and the receiver", () => {
    // Same vector as apps/mx-rs/src/ingest.rs (signs_exactly_like_the_receiver).
    expect(
      signMailRequest(
        "test-secret",
        1_800_000_000,
        "POST",
        "/internal/mail/check",
        '{"address":"abc@mailhooks.cc"}'
      )
    ).toBe("4a609ca17931689d182ad6d5e66deddfc95fb0801b9b232c880b30e53ed17a30");
  });
});

describe("buildTestEmail", () => {
  const now = new Date("2026-10-08T09:30:00Z");
  const email = buildTestEmail({
    to: "abc123@mailhooks.cc",
    appUrl: "https://webhooks.cc/",
    now,
  });

  it("builds a multipart message with headers, a code and a docs link", () => {
    expect(email.code).toMatch(/^\d{6}$/);
    expect(email.raw).toContain("From: webhooks.cc <test@webhooks.cc>\r\n");
    expect(email.raw).toContain("To: <abc123@mailhooks.cc>\r\n");
    expect(email.raw).toContain("Date: Thu, 08 Oct 2026 09:30:00 +0000\r\n");
    expect(email.raw).toContain(`${TEST_EMAIL_HEADER}: 1\r\n`);
    expect(email.raw).toContain("Content-Type: text/plain; charset=utf-8");
    expect(email.raw).toContain("Content-Type: text/html; charset=utf-8");
    expect(email.raw).toContain("https://webhooks.cc/docs/email-capture");
  });

  it("is something the extraction finds a code and a link in", () => {
    const text = email.raw
      .split("Content-Type: text/plain; charset=utf-8\r\n\r\n")[1]
      .split("\r\n--")[0];
    const found = extractFromEmail({ subject: "Test email from webhooks.cc", text, html: null });
    expect(found.codes).toEqual([email.code]);
    expect(found.links[0]?.url).toBe("https://webhooks.cc/docs/email-capture");
  });

  it("wraps the message in the deliver call body, base64 and not a retry", () => {
    const body = JSON.parse(testDeliveryBody({ to: "abc123@mailhooks.cc", raw: email.raw, now }));
    expect(body).toMatchObject({
      recipients: ["abc123@mailhooks.cc"],
      envelope_from: "test@webhooks.cc",
      received_at: "2026-10-08T09:30:00.000Z",
      retry: false,
    });
    expect(Buffer.from(body.raw, "base64").toString("utf8")).toBe(email.raw);
  });
});
