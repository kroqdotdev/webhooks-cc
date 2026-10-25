import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildEmailJson,
  emailFieldIssues,
  emailHeaderList,
  extractEmailFields,
  parseReply,
  renderInboundEmail,
  replyText,
  type EmailCapture,
  type EmailFieldFinder,
  type EmailJsonSource,
} from "../email";
import { evaluateConditions } from "../rules";

function capture(overrides: Partial<EmailCapture> = {}): EmailCapture {
  return {
    subject: "Invoice INV-2041 for October",
    from: [{ name: "Acme Billing", address: "billing@acme.example" }],
    to: [{ name: "Ops", address: "acme-orders+inv@mailhooks.cc" }],
    cc: [{ name: null, address: "finance@acme.example" }],
    replyTo: [],
    sender: [],
    date: "Sun, 25 Oct 2026 09:30:00 +0000",
    messageId: "abc@acme.example",
    inReplyTo: [],
    tag: "inv",
    text: "Thanks, paid.\n\nOn Sat, 24 Oct 2026 at 18:02, Acme Billing <billing@acme.example> wrote:\n> Invoice INV-2041: 42.00 EUR due\n> Pay by Friday\n",
    html: "<p>Total: <b>42.00 EUR</b></p>",
    textFromHtml: false,
    attachments: [],
    auth: {
      spf: { result: "pass", domain: "acme.example" },
      dkim: [{ result: "pass", domain: "acme.example", selector: "s1" }],
      dmarc: { result: "pass", domain: "acme.example", policy: "reject", reason: null },
      iprev: null,
      authenticationResults: null,
      error: null,
    },
    spam: {
      score: 1.5,
      required: 15,
      action: "no action",
      symbols: [{ name: "R_SPF_ALLOW", score: -0.2 }],
      error: null,
    },
    smtp: {
      clientIp: "192.0.2.25",
      clientRdns: "mail.acme.example",
      helo: "mail.acme.example",
      tls: { version: "TLSv1.3", cipher: "TLS_AES_128_GCM_SHA256" },
      envelopeFrom: "bounce@acme.example",
      envelopeTo: ["acme-orders+inv@mailhooks.cc"],
      size: 2048,
      test: false,
    },
    parseError: false,
    truncated: {
      raw: false,
      text: false,
      html: false,
      headers: false,
      addresses: false,
      attachments: false,
    },
    ...overrides,
  };
}

function source(overrides: Partial<EmailCapture> = {}): EmailJsonSource {
  return {
    id: "3f6c2a1e-8b7d-4c9e-a2f1-0d5b6e7c8a90",
    receivedAt: Date.UTC(2026, 9, 25, 9, 30),
    path: "acme-orders+inv@mailhooks.cc",
    size: 2048,
    headers: {
      from: "Acme Billing <billing@acme.example>",
      to: "Ops <acme-orders+inv@mailhooks.cc>",
      subject: "Invoice INV-2041 for October",
      received: "from a by b\nfrom c by d",
      "x-mailer": "Acme",
    },
    email: capture(overrides),
  };
}

const RAW = [
  "Received: from a by b",
  "Received: from c",
  "\tby d",
  "From: Acme Billing <billing@acme.example>",
  "To: Ops <acme-orders+inv@mailhooks.cc>",
  "Subject: Invoice INV-2041 for October",
  "Message-ID: <abc@acme.example>",
  "",
  "Thanks, paid.",
].join("\r\n");

// Tests only: the web app passes RE2 (apps/web/lib/email-fields.ts).
const find: EmailFieldFinder = (pattern, text) => {
  const match = new RegExp(pattern).exec(text);
  return match ? (match[1] ?? match[0]) : null;
};

describe("parseReply", () => {
  it("cuts the quoted message and keeps the new text", () => {
    expect(parseReply(capture().text)).toEqual({
      text: "Thanks, paid.",
      quoted: true,
      signature: null,
    });
  });

  it("finds a quote header that wraps onto a second line", () => {
    const text =
      "Sounds good.\n\nOn Sat, 24 Oct 2026 at 18:02, Ada Lovelace <ada@example.com>\nwrote:\n> Shall we?";
    expect(replyText(text)).toBe("Sounds good.");
  });

  it("knows Outlook's header block and other languages", () => {
    expect(
      replyText(
        "Done.\n\nFrom: Ada <ada@example.com>\nSent: Saturday\nTo: Bob\nSubject: Re: x\n\nOld"
      )
    ).toBe("Done.");
    expect(
      replyText("Danke!\n\nAm 24.10.2026 um 18:02 schrieb Ada <ada@example.com>:\n> Hallo")
    ).toBe("Danke!");
    expect(replyText("Merci.\n\nLe sam. 24 oct. 2026, Ada a écrit :\n> Salut")).toBe("Merci.");
    expect(replyText("Ok\n\n-----Original Message-----\nFrom: Ada")).toBe("Ok");
  });

  it("drops the signature and keeps it apart", () => {
    const parsed = parseReply("Yes, ship it.\n\n-- \nAda\nAcme\n\nOn Sat, Ada wrote:\n> ?");
    expect(parsed).toEqual({ text: "Yes, ship it.", quoted: true, signature: "-- \nAda\nAcme" });
    expect(parseReply("Hi\n\nSent from my iPhone").text).toBe("Hi");
  });

  it("keeps a reply's last line that only looks like the start of a header", () => {
    expect(
      replyText("On it.\nOn Tue, 3 Mar 2026 at 10:02, Ada <ada@example.com> wrote:\n> ?")
    ).toBe("On it.");
  });

  it("is null for an email that quotes nothing", () => {
    expect(replyText("Welcome aboard. Your code is 123456.")).toBeNull();
    expect(replyText(null)).toBeNull();
    expect(replyText("On Sat, Ada wrote:\n> only a quote")).toBeNull();
  });

  it("takes linear time on hostile input", () => {
    const hostile = `${"Am schrieb schrieb ".repeat(30)}\n`.repeat(5000) + "> x\n".repeat(5000);
    const started = performance.now();
    parseReply(hostile);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("email fields", () => {
  const fields = [
    { name: "invoice", from: "subject" as const, pattern: "(INV-\\d+)" },
    { name: "total", from: "html" as const, pattern: "Total: ([\\d.]+)" },
    { name: "mailer", from: "header" as const, header: "X-Mailer", pattern: ".+" },
    { name: "copied", from: "to" as const, pattern: "(finance@\\S+)" },
    { name: "missing", from: "text" as const, pattern: "PO-(\\d+)" },
  ];

  it("validates names, sources, headers and patterns", () => {
    expect(emailFieldIssues(fields)).toEqual([]);
    expect(emailFieldIssues("x")).toEqual(["emailFields must be a list"]);
    expect(
      emailFieldIssues([
        { name: "1bad", from: "subject", pattern: "x" },
        { name: "a", from: "body", pattern: "x" },
        { name: "a", from: "header", pattern: "" },
        { name: "b", from: "subject", header: "X", pattern: "y" },
      ])
    ).toEqual([
      "field 1: name must be letters, digits and _, start with a letter, at most 40 characters",
      "field 2: from must be one of subject, text, html, from, to, header",
      'field 3: the name "a" is used twice',
      "field 3: header must be a header name",
      "field 3: pattern is required",
      'field 4: header is only for from "header"',
    ]);
    expect(
      emailFieldIssues([{ name: "a", from: "text", pattern: "(" }], () => "missing )")
    ).toEqual(["field 1: pattern: missing )"]);
  });

  it("reads only the email's own headers, whatever a field is named", () => {
    const values = extractEmailFields(
      source(),
      [
        { name: "a", from: "header", header: "constructor", pattern: ".+" },
        { name: "b", from: "header", header: "__proto__", pattern: ".+" },
      ],
      find
    );
    expect(values).toEqual({ a: null, b: null });
  });

  it("reads the first 64 KB of a part", () => {
    const long = source({ text: `${"x".repeat(70_000)} INV-9999` });
    expect(
      extractEmailFields(long, [{ name: "late", from: "text", pattern: "(INV-\\d+)" }], find)
    ).toEqual({ late: null });
  });

  it("finds each field's value, or null", () => {
    expect(extractEmailFields(source(), fields, find)).toEqual({
      invoice: "INV-2041",
      total: "42.00",
      mailer: "Acme",
      copied: "finance@acme.example",
      missing: null,
    });
  });

  it("goes into the email JSON, with the reply text", () => {
    const values = extractEmailFields(source(), fields, find);
    const json = buildEmailJson(source(), { slug: "acme-orders" }, { fields: values });
    expect(json.data.fields).toEqual(values);
    expect(json.data.replyText).toBe("Thanks, paid.");
    expect(buildEmailJson(source(), { slug: "acme-orders" }).data).not.toHaveProperty("fields");
  });

  it("can be filtered on", () => {
    const subject = {
      method: "EMAIL",
      path: "acme-orders@mailhooks.cc",
      headers: {},
      query: {},
      body: "",
      kind: "email" as const,
      email: {
        subject: null,
        from: null,
        to: [],
        text: null,
        tag: null,
        spamScore: null,
        auth: { spf: null, dkim: null, dmarc: null },
        fields: { total: "42.00", missing: null },
      },
    };
    const holds = (condition: object) =>
      evaluateConditions({ conditions: [condition as never] }, subject);
    expect(holds({ field: "email_field", name: "total", op: "gt", value: "40" })).toBe(true);
    expect(holds({ field: "email_field", name: "missing", op: "exists" })).toBe(false);
    expect(holds({ field: "email_field", name: "nope", op: "not_exists" })).toBe(true);
  });
});

describe("inbound shapes", () => {
  it("reads the raw header block in order, unfolded", () => {
    expect(emailHeaderList(source(), RAW)).toEqual([
      ["Received", "from a by b"],
      ["Received", "from c by d"],
      ["From", "Acme Billing <billing@acme.example>"],
      ["To", "Ops <acme-orders+inv@mailhooks.cc>"],
      ["Subject", "Invoice INV-2041 for October"],
      ["Message-ID", "<abc@acme.example>"],
    ]);
    expect(emailHeaderList(source())).toContainEqual(["Received", "from c by d"]);
    expect(emailHeaderList(source())).toContainEqual(["X-Mailer", "Acme"]);
  });

  it("renders Postmark's inbound JSON", async () => {
    const out = await renderInboundEmail("postmark", source(), { raw: RAW });
    expect(out.contentType).toBe("application/json");
    const body = JSON.parse(out.body);
    expect(body).toMatchObject({
      FromName: "Acme Billing",
      From: "billing@acme.example",
      FromFull: { Email: "billing@acme.example", Name: "Acme Billing", MailboxHash: "" },
      ToFull: [{ Email: "acme-orders+inv@mailhooks.cc", Name: "Ops", MailboxHash: "inv" }],
      OriginalRecipient: "acme-orders+inv@mailhooks.cc",
      MailboxHash: "inv",
      MessageStream: "inbound",
      StrippedTextReply: "Thanks, paid.",
      Attachments: [],
    });
    expect(body.Headers).toContainEqual({ Name: "Received", Value: "from c by d" });
    expect(body.Headers).toContainEqual({ Name: "X-Spam-Score", Value: "1.5" });
    expect(body.Headers.map((h: { Name: string }) => h.Name)).not.toContain("Subject");
  });

  it("keeps a sender's odd header names as plain keys", async () => {
    const raw = "Constructor: x\r\n__proto__: y\r\nSubject: Hi\r\n\r\nBody";
    const body = JSON.parse((await renderInboundEmail("cloudmailin", source(), { raw })).body);
    expect(body.headers.constructor).toBe("x");
    expect(body.headers.__proto__).toBe("y");
    expect(body.headers.subject).toBe("Hi");
  });

  it("gives Postmark the Date header as written", async () => {
    const withDate = {
      ...source(),
      headers: { ...source().headers, date: "Sun, 25 Oct 2026 09:30:00 +0000" },
    };
    const body = JSON.parse((await renderInboundEmail("postmark", withDate)).body);
    expect(body.Date).toBe("Sun, 25 Oct 2026 09:30:00 +0000");
  });

  it("renders CloudMailin's JSON Normalized", async () => {
    const body = JSON.parse((await renderInboundEmail("cloudmailin", source(), { raw: RAW })).body);
    expect(body.headers.received).toEqual(["from a by b", "from c by d"]);
    expect(body.headers.message_id).toBe("<abc@acme.example>");
    expect(body.envelope).toEqual({
      to: "acme-orders+inv@mailhooks.cc",
      recipients: ["acme-orders+inv@mailhooks.cc"],
      from: "bounce@acme.example",
      helo_domain: "mail.acme.example",
      remote_ip: "192.0.2.25",
      spf: { result: "pass", domain: "acme.example" },
      tls: true,
    });
    expect(body.reply_plain).toBe("Thanks, paid.");
    expect(body.attachments).toEqual([]);
  });

  it("renders SendGrid's Inbound Parse form", async () => {
    const out = await renderInboundEmail("sendgrid", source(), { raw: RAW, boundary: "xYzZY" });
    expect(out.contentType).toBe("multipart/form-data; boundary=xYzZY");
    const form = await new Response(out.body, {
      headers: { "content-type": out.contentType },
    }).formData();
    expect(form.get("subject")).toBe("Invoice INV-2041 for October");
    expect(form.get("SPF")).toBe("pass");
    expect(form.get("dkim")).toBe("{@acme.example : pass}");
    expect(form.get("spam_score")).toBe("1.5");
    expect(JSON.parse(form.get("envelope") as string)).toEqual({
      to: ["acme-orders+inv@mailhooks.cc"],
      from: "bounce@acme.example",
    });
    expect(form.get("attachments")).toBe("0");
    expect(String(form.get("headers"))).toContain("Received: from c by d");
  });

  it("renders a Mailgun route form, signed as Mailgun signs it", async () => {
    const out = await renderInboundEmail("mailgun", source(), {
      raw: RAW,
      mailgunSigningKey: "key-acme-test",
      now: 1_793_000_000_000,
      token: "t".repeat(50),
    });
    expect(out.contentType).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(out.body);
    expect(form.get("recipient")).toBe("acme-orders+inv@mailhooks.cc");
    expect(form.get("sender")).toBe("bounce@acme.example");
    expect(form.get("stripped-text")).toBe("Thanks, paid.");
    expect(JSON.parse(form.get("message-headers")!)[0]).toEqual(["Received", "from a by b"]);
    const expected = createHmac("sha256", "key-acme-test")
      .update(`1793000000${"t".repeat(50)}`)
      .digest("hex");
    expect(form.get("signature")).toBe(expected);
    const unsigned = await renderInboundEmail("mailgun", source(), { token: "t".repeat(50) });
    expect(new URLSearchParams(unsigned.body).get("signature")).toBe("");
  });
});
