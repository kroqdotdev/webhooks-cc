import { describe, expect, it } from "vitest";
import { toEmailCapture } from "./email-capture";
import { buildEmailJson } from "@webhooks-cc/sdk/email";

const stored = {
  subject: "Confirm your email for Tidewater",
  from: [{ name: "Tidewater", address: "no-reply@tidewater.app" }],
  to: [{ name: null, address: "acme+signup@mailhooks.cc" }],
  cc: [],
  reply_to: [],
  sender: [],
  tag: "signup",
  date: "2026-10-08T09:30:00Z",
  message_id: "179141283833.2345901@tidewater.app",
  in_reply_to: [],
  text: "Your confirmation code is 482913.\n\nConfirm: https://app.tidewater.app/confirm?token=Zk3q9v\n",
  html: '<p>Your code is</p><p>482913</p><a href="https://app.tidewater.app/confirm?token=Zk3q9v">Confirm email</a>',
  text_from_html: false,
  attachments: [
    { filename: "invoice.pdf", content_type: "application/pdf", size: 48211, inline: false },
  ],
  auth: {
    spf: { result: "pass", domain: "tidewater.app" },
    dkim: [
      { result: "fail", domain: "old.tidewater.app" },
      { result: "pass", domain: "tidewater.app" },
    ],
    dmarc: { result: "pass", domain: "tidewater.app", policy: "reject" },
  },
  smtp: { tls: { version: "TLSv1_3", cipher: "TLS13_AES_256_GCM_SHA384" }, size: 1485 },
  parse_error: false,
  raw_truncated: false,
  text_truncated: false,
  html_truncated: true,
};

const source = {
  id: "0b9e5f3a-6c1d-4f7e-9a2b-3c4d5e6f7a8b",
  receivedAt: Date.parse("2026-10-08T09:30:01.882Z"),
  path: "acme+signup@mailhooks.cc",
  size: 900,
  headers: { subject: "Confirm your email for Tidewater" },
  email: toEmailCapture(stored)!,
};

describe("buildEmailJson", () => {
  it("builds the documented shape, stamped with the receive time", () => {
    const json = buildEmailJson(
      source,
      { slug: "acme", name: "Signup flow" },
      { includeExtracts: true }
    );
    expect(json).toMatchObject({
      type: "email.received",
      timestamp: "2026-10-08T09:30:01.882Z",
      data: {
        id: source.id,
        endpoint: { slug: "acme", name: "Signup flow" },
        receivedAt: "2026-10-08T09:30:01.882Z",
        address: "acme+signup@mailhooks.cc",
        tag: "signup",
        subject: "Confirm your email for Tidewater",
        from: { name: "Tidewater", address: "no-reply@tidewater.app" },
        to: [{ name: null, address: "acme+signup@mailhooks.cc" }],
        messageId: "179141283833.2345901@tidewater.app",
        codes: ["482913"],
        links: [{ url: "https://app.tidewater.app/confirm?token=Zk3q9v", text: "Confirm email" }],
        attachments: [
          {
            filename: "invoice.pdf",
            contentType: "application/pdf",
            size: 48211,
            contentId: null,
            inline: false,
          },
        ],
        // A passing signature wins over a failing one.
        auth: { spf: "pass", dkim: "pass", dmarc: "pass", tls: "TLSv1_3" },
        headers: { subject: "Confirm your email for Tidewater" },
        size: 1485,
        truncated: { text: false, html: true },
        test: false,
      },
    });
  });

  it("leaves codes and links out when the endpoint turned them off", () => {
    const json = buildEmailJson(source, { slug: "acme", name: null }, { includeExtracts: false });
    expect(json.data).not.toHaveProperty("codes");
    expect(json.data).not.toHaveProperty("links");
    expect(json.data.endpoint).toEqual({ slug: "acme", name: null });
  });

  it("is the same JSON every time for the same email", () => {
    const options = { includeExtracts: true };
    expect(JSON.stringify(buildEmailJson(source, { slug: "acme", name: "x" }, options))).toBe(
      JSON.stringify(buildEmailJson(source, { slug: "acme", name: "x" }, options))
    );
  });

  it("reports checks that did not run as null and falls back to the stored size", () => {
    const json = buildEmailJson(
      { ...source, email: toEmailCapture({ subject: "Plain" })! },
      { slug: "acme", name: null },
      { includeExtracts: true }
    );
    expect(json.data.auth).toEqual({ spf: null, dkim: null, dmarc: null, tls: null });
    expect(json.data.from).toBeNull();
    expect(json.data.size).toBe(900);
  });
});
