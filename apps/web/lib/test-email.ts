import { createHmac, randomInt, randomUUID } from "node:crypto";
import type { LayoutTemplate } from "@/lib/layout-templates";

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

interface TestEmailInput {
  to: string;
  appUrl: string;
  now?: Date;
  /** The site whose dashboard sent it, named in the message (the sender address stays webhooks.cc). */
  siteName?: string;
}

/**
 * A small multipart message with a code and a link, so the whole email view
 * has something to show. With a template, the template's sample email
 * instead (see `sampleTestEmail`), which has no code.
 */
export function buildTestEmail(input: TestEmailInput & { template?: undefined }): TestEmail;
export function buildTestEmail(
  input: TestEmailInput & { template: LayoutTemplate }
): Omit<TestEmail, "code"> & { code: null };
export function buildTestEmail(
  input: TestEmailInput & { template?: LayoutTemplate }
): Omit<TestEmail, "code"> & { code: string | null };
export function buildTestEmail(
  input: TestEmailInput & { template?: LayoutTemplate }
): Omit<TestEmail, "code"> & { code: string | null } {
  if (input.template) {
    return { raw: sampleTestEmail({ ...input, template: input.template }), code: null };
  }
  const now = input.now ?? new Date();
  const siteName = input.siteName ?? "webhooks.cc";
  const code = String(randomInt(100000, 1000000));
  const boundary = `webhooks-test-${randomUUID()}`;
  const link = `${input.appUrl.replace(/\/$/, "")}/docs/email-capture`;
  const text = [
    `This is a test email from your ${siteName} dashboard.`,
    "",
    `Your test code is ${code}.`,
    "",
    `Read how email capture works: ${link}`,
  ].join("\r\n");
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#18181b">',
    '<h1 style="font-size:20px;margin:0 0 12px">Test email</h1>',
    `<p>This is a test email from your ${siteName} dashboard.</p>`,
    "<p>Your test code is</p>",
    `<p style="font-size:28px;letter-spacing:4px;font-weight:bold;margin:4px 0 16px">${code}</p>`,
    `<p><a href="${link}" style="color:#047857">How email capture works</a></p>`,
    "</div>",
  ].join("");
  const headers = [
    `From: ${siteName} <${FROM}>`,
    `To: <${input.to}>`,
    `Subject: Test email from ${siteName}`,
    ...commonHeaders(now),
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

function commonHeaders(now: Date): string[] {
  return [
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomUUID()}@webhooks.cc>`,
    `${TEST_EMAIL_HEADER}: 1`,
    "MIME-Version: 1.0",
  ];
}

/** Printable ASCII only: anything else in a header goes as an RFC 2047 word. */
const PLAIN_HEADER = /^[\x20-\x7e]*$/;

/** A header value in RFC 2047 encoded words when it is not plain ASCII, folded between words. */
function encodeWords(value: string): string {
  if (PLAIN_HEADER.test(value)) return value;
  // At most 39 bytes a word keeps each line, "Subject: " included, under 78
  // characters; words split between characters, never inside one.
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, "utf8") > 39) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

/** A display name: quoted when plain, encoded words otherwise. */
function displayName(name: string): string {
  return PLAIN_HEADER.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : encodeWords(name);
}

/** A part's body in base64, 76 characters a line, so any text and any line length travel safely. */
function base64Lines(content: string): string {
  return (
    Buffer.from(content, "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
}

/**
 * A ready-made layout's sample email (lib/layout-templates.ts), so a layout
 * added from a template has something to read before real mail arrives.
 * The subject, text and HTML are the sample's; the sender is not: the From
 * address stays the test address on webhooks.cc and only the display name
 * names the sender, marked as a sample, so nothing claims to come from the
 * company. The sample's attachment is named in its text but not attached
 * (its contents are not part of the template).
 */
export function sampleTestEmail(input: {
  to: string;
  now?: Date;
  template: LayoutTemplate;
}): string {
  const now = input.now ?? new Date();
  const { sample, sender } = input.template;
  // Mail's text is CRLF on the wire; the samples are written with LF.
  const text = sample.text.replace(/\r?\n/g, "\r\n");
  const headers = [
    `From: ${displayName(`${sender} (sample)`)} <${FROM}>`,
    `To: <${input.to}>`,
    `Subject: ${encodeWords(sample.subject)}`,
    ...commonHeaders(now),
  ];
  const part = (type: "plain" | "html", content: string) => [
    `Content-Type: text/${type}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(content),
  ];
  if (!sample.html) {
    return [...headers, ...part("plain", text), ""].join("\r\n");
  }
  const boundary = `webhooks-test-${randomUUID()}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...part("plain", text),
    `--${boundary}`,
    ...part("html", sample.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
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
