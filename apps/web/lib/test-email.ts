import { createHmac, randomInt, randomUUID } from "node:crypto";

/**
 * "Send test email": a sample message delivered straight to an endpoint
 * through the receiver's private mail API, the same signed call the MX host
 * makes (apps/receiver-rs/src/mail/auth.rs). Nothing goes through SMTP.
 */

export const DELIVER_PATH = "/internal/mail/deliver";
/**
 * Marks the sample for whoever reads the raw message. The dashboard does not
 * trust it (any sender can add it); it reads the receiver's `smtp.test`,
 * set because the delivery below says `test: true`.
 */
export const TEST_EMAIL_HEADER = "X-Webhooks-Test";
const FROM = "test@webhooks.cc";

/** Hex HMAC-SHA256 of "{timestamp}.{METHOD}.{path}." followed by the body. */
export function signMailRequest(
  secret: string,
  timestamp: number,
  method: string,
  path: string,
  body: string
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${method}.${path}.`)
    .update(body)
    .digest("hex");
}

export interface TestEmail {
  raw: string;
  code: string;
}

/** A small multipart message with a code and a link, so the whole email view has something to show. */
export function buildTestEmail(input: { to: string; appUrl: string; now?: Date }): TestEmail {
  const now = input.now ?? new Date();
  const code = String(randomInt(100000, 1000000));
  const boundary = `webhooks-test-${randomUUID()}`;
  const link = `${input.appUrl.replace(/\/$/, "")}/docs/email-capture`;
  const text = [
    "This is a test email from your webhooks.cc dashboard.",
    "",
    `Your test code is ${code}.`,
    "",
    `Read how email capture works: ${link}`,
  ].join("\r\n");
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#18181b">',
    '<h1 style="font-size:20px;margin:0 0 12px">Test email</h1>',
    "<p>This is a test email from your webhooks.cc dashboard.</p>",
    "<p>Your test code is</p>",
    `<p style="font-size:28px;letter-spacing:4px;font-weight:bold;margin:4px 0 16px">${code}</p>`,
    `<p><a href="${link}" style="color:#047857">Read how email capture works</a></p>`,
    "</div>",
  ].join("");
  const headers = [
    `From: webhooks.cc <${FROM}>`,
    `To: <${input.to}>`,
    "Subject: Test email from webhooks.cc",
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomUUID()}@webhooks.cc>`,
    `${TEST_EMAIL_HEADER}: 1`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const raw = [
    ...headers,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { raw, code };
}

/** The JSON body for the receiver's deliver call. */
export function testDeliveryBody(input: { to: string; raw: string; now?: Date }): string {
  return JSON.stringify({
    recipients: [input.to],
    envelope_from: FROM,
    helo: "webhooks.cc",
    received_at: (input.now ?? new Date()).toISOString(),
    retry: false,
    test: true,
    raw: Buffer.from(input.raw, "utf8").toString("base64"),
  });
}
