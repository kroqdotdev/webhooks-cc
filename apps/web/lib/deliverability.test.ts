import { describe, expect, it } from "vitest";
import type { EmailCapture, EmailSenderSetup } from "@webhooks-cc/sdk/email";
import { deliverabilityReport, type Finding } from "./deliverability";

const receivedAt = Date.parse("2026-11-03T10:00:00Z");

function setup(overrides: Partial<EmailSenderSetup> = {}): EmailSenderSetup {
  return {
    spf: {
      domain: "acme.example",
      records: 1,
      record: "v=spf1 include:_spf.example.net -all",
      all: "-all",
      redirect: false,
      lookups: 3,
      lookupsCapped: false,
      ptr: false,
      error: null,
    },
    dmarc: {
      p: "reject",
      sp: null,
      adkim: "relaxed",
      aspf: "relaxed",
      rua: ["dmarc@acme.example"],
      ruf: 0,
      testing: false,
    },
    dkim: [
      {
        domain: "acme.example",
        selector: "s1",
        algorithm: "rsa-sha256",
        key: "rsa",
        bits: 2048,
        revoked: false,
      },
    ],
    bimi: { found: false, domain: null, logo: false, authority: false, error: null },
    helo: {
      name: "mail.acme.example",
      ipLiteral: false,
      fqdn: true,
      resolves: true,
      matchesPtr: true,
    },
    error: null,
    ...overrides,
  };
}

/** A well set up transactional email. */
function email(overrides: Partial<EmailCapture> = {}): EmailCapture {
  return {
    subject: "Your receipt",
    from: [{ name: "Acme", address: "billing@acme.example" }],
    to: [{ name: null, address: "a@mailhooks.cc" }],
    cc: [],
    replyTo: [],
    sender: [],
    date: "2026-11-03T09:59:58Z",
    messageId: "abc@acme.example",
    inReplyTo: [],
    tag: null,
    text: "Thanks for your order. ".repeat(20),
    html: `<p>${"Thanks for your order. ".repeat(20)}</p><img src="https://acme.example/logo.png"><a href="https://acme.example/orders/1">View your order</a>`,
    textFromHtml: false,
    attachments: [],
    auth: {
      spf: { result: "pass", domain: "acme.example" },
      dkim: [{ result: "pass", domain: "acme.example", selector: "s1" }],
      dmarc: {
        result: "pass",
        domain: "acme.example",
        policy: "reject",
        reason: null,
        spf: "pass",
        dkim: "pass",
      },
      iprev: { result: "pass", ptr: "mail.acme.example" },
      authenticationResults: null,
      arc: { result: "none", sets: 0, sealers: [], reason: null },
      setup: setup(),
      error: null,
    },
    spam: null,
    smtp: {
      clientIp: "192.0.2.1",
      clientRdns: "mail.acme.example",
      helo: "mail.acme.example",
      tls: { version: "TLSv1_3", cipher: "TLS13_AES_256_GCM_SHA384" },
      envelopeFrom: "bounce@acme.example",
      envelopeTo: ["a@mailhooks.cc"],
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

function report(capture: EmailCapture, headers: Record<string, string> = {}) {
  return deliverabilityReport({ email: capture, headers, receivedAt });
}

function byId(findings: Finding[]): Record<string, Finding["status"]> {
  return Object.fromEntries(findings.map((finding) => [finding.id, finding.status]));
}

describe("deliverabilityReport", () => {
  it("passes a well set up email, with unsubscribe left as information", () => {
    const { findings, setupRecorded } = report(email());
    expect(setupRecorded).toBe(true);
    expect(byId(findings)).toEqual({
      "spf-all": "pass",
      "spf-lookups": "pass",
      "dmarc-policy": "pass",
      "dmarc-reports": "pass",
      alignment: "pass",
      "dkim-key-acme.example-s1": "pass",
      ptr: "pass",
      helo: "pass",
      tls: "pass",
      bimi: "info",
      "message-id": "pass",
      "text-part": "pass",
      unsubscribe: "info",
      links: "pass",
      images: "pass",
    });
    const emDash = String.fromCharCode(0x2014);
    expect(findings.every((f) => !f.title.includes(emDash) && !f.detail.includes(emDash))).toBe(
      true
    );
  });

  it("flags a weak sender setup", () => {
    const capture = email();
    capture.auth!.setup = setup({
      spf: { ...setup().spf!, all: "+all", lookups: 12, ptr: true },
      dmarc: { ...setup().dmarc!, p: "none", rua: [], testing: true },
      dkim: [
        { ...setup().dkim[0], bits: 1024, algorithm: "rsa-sha1" },
        { ...setup().dkim[0], selector: "old", key: "rsa", bits: null, revoked: true },
        { ...setup().dkim[0], selector: "gone", key: null, bits: null },
      ],
      helo: {
        name: "[192.0.2.1]",
        ipLiteral: true,
        fqdn: false,
        resolves: false,
        matchesPtr: false,
      },
      bimi: { found: true, domain: "acme.example", logo: true, authority: false, error: null },
    });
    expect(byId(report(capture).findings)).toMatchObject({
      "spf-all": "fail",
      "spf-lookups": "fail",
      "spf-ptr": "warn",
      "dmarc-policy": "warn",
      "dmarc-testing": "warn",
      "dmarc-reports": "warn",
      "dkim-key-acme.example-s1": "warn",
      "dkim-key-acme.example-s1-sha1": "fail",
      "dkim-key-acme.example-old": "fail",
      "dkim-key-acme.example-gone": "fail",
      helo: "warn",
      bimi: "warn",
    });
  });

  it("calls out missing and duplicate records", () => {
    const none = email();
    none.auth!.setup = setup({ spf: { ...setup().spf!, records: 0 }, dmarc: null });
    none.auth!.dmarc = {
      result: "none",
      domain: "acme.example",
      policy: "unspecified",
      reason: null,
    };
    expect(byId(report(none).findings)).toMatchObject({
      "spf-record": "fail",
      "dmarc-record": "fail",
    });

    const two = email();
    two.auth!.setup = setup({ spf: { ...setup().spf!, records: 2 } });
    const findings = byId(report(two).findings);
    expect(findings["spf-record"]).toBe("fail");
    expect(findings["spf-all"]).toBeUndefined();
  });

  it("judges older mail by what was recorded then", () => {
    const old = email();
    old.auth = { ...old.auth!, setup: null, arc: null, dkim: [] };
    old.auth.dmarc = { result: "none", domain: "acme.example", policy: null, reason: null };
    const { findings, setupRecorded } = report(old);
    expect(setupRecorded).toBe(false);
    const ids = byId(findings);
    expect(ids).toMatchObject({ "dmarc-record": "fail", "dkim-signed": "fail", ptr: "pass" });
    expect(ids["spf-all"]).toBeUndefined();
    expect(ids.helo).toBeUndefined();
  });

  it("does not take a timed-out lookup or several From domains for a missing DMARC record", () => {
    const late = email();
    late.auth!.setup = {
      ...setup({ dmarc: null, spf: null, dkim: [], helo: null, bimi: null }),
      error: "timeout",
    };
    expect(byId(report(late).findings)["dmarc-record"]).toBeUndefined();

    const several = email({
      from: [
        { name: null, address: "a@acme.example" },
        { name: null, address: "b@other.example" },
      ],
    });
    several.auth!.setup = setup({ dmarc: null });
    expect(byId(report(several).findings)).toMatchObject({ from: "warn" });
    expect(byId(report(several).findings)["dmarc-record"]).toBeUndefined();
  });

  it("reports alignment failures", () => {
    const capture = email();
    capture.auth!.dmarc = {
      result: "fail",
      domain: "acme.example",
      policy: "reject",
      reason: null,
      spf: "fail",
      dkim: "fail",
    };
    const finding = report(capture).findings.find((f) => f.id === "alignment");
    expect(finding?.status).toBe("fail");
    expect(finding?.detail).toContain("DKIM relaxed, SPF relaxed");
  });

  it("reads the ARC chain of forwarded mail", () => {
    const capture = email();
    capture.auth!.arc = {
      result: "pass",
      sets: 2,
      sealers: ["lists.example.org", "google.com"],
      reason: null,
    };
    expect(report(capture).findings.find((f) => f.id === "arc")).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("2 servers (lists.example.org, google.com)"),
    });
    capture.auth!.arc = { result: "fail", sets: 1, sealers: [], reason: null };
    expect(byId(report(capture).findings).arc).toBe("warn");
  });

  it("checks the headers bulk senders need", () => {
    const missing = email({ messageId: null, date: null, subject: "", from: [] });
    expect(byId(report(missing).findings)).toMatchObject({
      "message-id": "fail",
      date: "fail",
      subject: "warn",
      from: "fail",
    });
    const skewed = email({ date: "2026-10-01T00:00:00Z" });
    expect(byId(report(skewed).findings).date).toBe("warn");

    const unsubscribe = (headers: Record<string, string>) =>
      byId(report(email(), headers).findings).unsubscribe;
    expect(unsubscribe({ "list-unsubscribe": "<mailto:u@acme.example>" })).toBe("warn");
    expect(unsubscribe({ "list-unsubscribe": "<https://acme.example/u?x=1>" })).toBe("warn");
    expect(
      unsubscribe({
        "list-unsubscribe": "<mailto:u@acme.example>, <https://acme.example/u?x=1>",
        "list-unsubscribe-post": "List-Unsubscribe=One-Click",
      })
    ).toBe("pass");
  });

  it("looks at the HTML: parts, links, images and size", () => {
    const htmlOnly = email({ textFromHtml: true });
    expect(byId(report(htmlOnly).findings)["text-part"]).toBe("warn");

    const links = email({
      html: [
        '<a href="https://click.tracker.example/r/1">https://acme.example/orders</a>',
        '<a href="https://www.acme.example/help">acme.example</a>',
        '<a href="https://news.acme.example/x">www.acme.example</a>',
        '<a href="https://bit.ly/3abc">deal</a>',
        '<a href="http://192.0.2.9/login">sign in</a>',
        `<p>${"words ".repeat(50)}</p>`,
      ].join(""),
    });
    const findings = report(links).findings;
    expect(byId(findings)).toMatchObject({
      "links-text": "warn",
      "links-shorteners": "warn",
      "links-ip": "warn",
      "links-http": "info",
    });
    expect(findings.find((f) => f.id === "links-text")?.detail).toContain(
      "acme.example goes to click.tracker.example"
    );
    expect(findings.find((f) => f.id === "links-text")?.detail).not.toContain("news.acme.example");
    expect(byId(findings).links).toBeUndefined();

    const images = email({ html: '<img src="a.png"><img src="b.png"><p>Sale</p>' });
    expect(byId(report(images).findings).images).toBe("warn");

    const large = email({ html: `<p>${"x".repeat(110 * 1024)}</p>` });
    expect(byId(report(large).findings).size).toBe("warn");
  });

  it("says nothing about checks that could not run", () => {
    const capture = email();
    capture.auth = { ...capture.auth!, error: "timeout" };
    const ids = byId(report(capture).findings);
    expect(ids.alignment).toBeUndefined();
    expect(ids.ptr).toBeUndefined();
    expect(ids["message-id"]).toBe("pass");
  });
});
