import { describe, expect, it } from "vitest";
import { isCaptureDomainAddress, toEmailCapture, toEmailSummary } from "./email-capture";

// The shape the receiver stores (requests.email), as captured in development.
const stored = {
  cc: [],
  to: [{ name: null, address: "acme-signup-flow+signup@mailhooks.cc" }],
  tag: "signup",
  auth: {
    spf: { domain: "tidewater.app", result: "fail" },
    dkim: [{ result: "pass", domain: "tidewater.app", selector: "s1" }],
    dmarc: { spf: "none", dkim: "none", domain: "tidewater.app", policy: "none", result: "none" },
    iprev: { ptr: "localhost", result: "pass" },
    authentication_results: "mx.mailhooks.cc;\r\n\tspf=fail smtp.mailfrom=no-reply@tidewater.app",
  },
  date: "2026-10-07T22:40:38Z",
  from: [{ name: "Tidewater", address: "no-reply@tidewater.app" }],
  html: "<p>Your code is <b>482913</b></p>",
  smtp: {
    tls: { version: "TLSv1_3", cipher: "TLS13_AES_256_GCM_SHA384" },
    helo: "mail-ot1-f41.google.com",
    size: 1485,
    client_ip: "127.0.0.1",
    client_rdns: "localhost",
    envelope_to: ["acme-signup-flow+signup@mailhooks.cc"],
    envelope_from: "no-reply@tidewater.app",
  },
  text: "Your code is 482913",
  sender: [],
  subject: "Confirm your email for Tidewater",
  reply_to: [],
  message_id: "179141283833.2345901@tidewater.app",
  attachments: [
    {
      size: 48009,
      inline: false,
      filename: "receipt.pdf",
      content_id: null,
      content_type: "application/pdf",
    },
    {
      size: 812,
      inline: true,
      filename: "logo.png",
      content_id: "logo",
      content_type: "image/png",
    },
  ],
  in_reply_to: [],
  parse_error: false,
  raw_truncated: false,
  html_truncated: false,
  text_from_html: false,
  text_truncated: true,
  headers_oversized: false,
  addresses_truncated: false,
  attachments_truncated: false,
};

describe("toEmailCapture", () => {
  it("maps the stored JSON to camelCase fields", () => {
    const capture = toEmailCapture(stored);
    expect(capture).toMatchObject({
      subject: "Confirm your email for Tidewater",
      from: [{ name: "Tidewater", address: "no-reply@tidewater.app" }],
      to: [{ name: null, address: "acme-signup-flow+signup@mailhooks.cc" }],
      tag: "signup",
      messageId: "179141283833.2345901@tidewater.app",
      text: "Your code is 482913",
      html: "<p>Your code is <b>482913</b></p>",
      parseError: false,
    });
    expect(capture?.attachments[0]).toEqual({
      filename: "receipt.pdf",
      contentType: "application/pdf",
      size: 48009,
      contentId: null,
      inline: false,
    });
    expect(capture?.truncated).toEqual({
      raw: false,
      text: true,
      html: false,
      headers: false,
      addresses: false,
      attachments: false,
    });
  });

  it("maps authentication and delivery details", () => {
    const capture = toEmailCapture(stored);
    expect(capture?.auth).toEqual({
      spf: { result: "fail", domain: "tidewater.app" },
      dkim: [{ result: "pass", domain: "tidewater.app", selector: "s1" }],
      dmarc: { result: "none", domain: "tidewater.app", policy: "none", reason: null },
      iprev: { result: "pass", ptr: "localhost" },
      authenticationResults: "mx.mailhooks.cc;\r\n\tspf=fail smtp.mailfrom=no-reply@tidewater.app",
      error: null,
    });
    expect(capture?.smtp).toEqual({
      clientIp: "127.0.0.1",
      clientRdns: "localhost",
      helo: "mail-ot1-f41.google.com",
      tls: { version: "TLSv1_3", cipher: "TLS13_AES_256_GCM_SHA384" },
      envelopeFrom: "no-reply@tidewater.app",
      envelopeTo: ["acme-signup-flow+signup@mailhooks.cc"],
      size: 1485,
      test: false,
    });
  });

  it("marks a test only when the receiver says so", () => {
    expect(toEmailCapture({ smtp: { test: true } })?.smtp?.test).toBe(true);
    expect(toEmailCapture({ smtp: { test: "true" } })?.smtp?.test).toBe(false);
    expect(toEmailCapture({ smtp: {} })?.smtp?.test).toBe(false);
  });

  it("reports checks that could not run", () => {
    expect(toEmailCapture({ auth: { error: "timeout" } })?.auth).toEqual({
      spf: null,
      dkim: [],
      dmarc: null,
      iprev: null,
      authenticationResults: null,
      error: "timeout",
    });
  });

  it("turns anything malformed into nulls and empty lists", () => {
    expect(toEmailCapture(null)).toBeNull();
    expect(toEmailCapture("not an object")).toBeNull();
    expect(toEmailCapture([1, 2])).toBeNull();
    const capture = toEmailCapture({
      subject: 42,
      from: "someone",
      to: [null, { name: 1 }, { address: "a@mailhooks.cc" }],
      attachments: [{ size: "big" }, "x"],
      auth: { spf: "pass", dkim: [{ result: 3 }], iprev: { ptr: "x" } },
      smtp: { tls: "yes", envelope_to: ["a@mailhooks.cc", 7] },
    });
    expect(capture).toMatchObject({
      subject: null,
      from: [],
      to: [{ name: null, address: "a@mailhooks.cc" }],
      attachments: [
        {
          filename: null,
          contentType: "application/octet-stream",
          size: 0,
          contentId: null,
          inline: false,
        },
      ],
      auth: { spf: null, dkim: [], iprev: null },
      smtp: { tls: null, envelopeTo: ["a@mailhooks.cc"] },
    });
  });
});

describe("toEmailSummary", () => {
  it("keeps what a list row shows and counts only real attachments", () => {
    expect(toEmailSummary(toEmailCapture(stored))).toEqual({
      subject: "Confirm your email for Tidewater",
      from: { name: "Tidewater", address: "no-reply@tidewater.app" },
      tag: "signup",
      attachmentCount: 1,
    });
  });

  it("falls back to the Sender header and handles a missing capture", () => {
    expect(
      toEmailSummary(toEmailCapture({ sender: [{ name: "Relay", address: "relay@example.com" }] }))
    ).toMatchObject({ from: { name: "Relay", address: "relay@example.com" } });
    expect(toEmailSummary(null)).toBeNull();
  });
});

describe("isCaptureDomainAddress", () => {
  it("matches the capture domain and its subdomains, case and trailing dot aside", () => {
    expect(isCaptureDomainAddress("abc+run@mailhooks.cc", "mailhooks.cc")).toBe(true);
    expect(isCaptureDomainAddress("abc@MailHooks.CC.", "mailhooks.cc")).toBe(true);
    expect(isCaptureDomainAddress("abc@mx.mailhooks.cc", "mailhooks.cc")).toBe(true);
  });

  it("does not match other domains", () => {
    expect(isCaptureDomainAddress("abc@notmailhooks.cc", "mailhooks.cc")).toBe(false);
    expect(isCaptureDomainAddress("abc@mailhooks.cc.example.com", "mailhooks.cc")).toBe(false);
    expect(isCaptureDomainAddress("abc@example.com", "mailhooks.cc")).toBe(false);
    expect(isCaptureDomainAddress("no-at-sign", "mailhooks.cc")).toBe(false);
  });
});
