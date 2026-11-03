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
      missingIncludes: [],
      duplicateIncludes: [],
      lookupsIncomplete: false,
      lookupsUnfollowed: false,
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
        error: null,
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
      "dkim-key-0-acme.example-s1": "pass",
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
    capture.auth!.dmarc!.policy = "none";
    expect(byId(report(capture).findings)).toMatchObject({
      "spf-all": "fail",
      "spf-lookups": "fail",
      "spf-ptr": "warn",
      "dmarc-policy": "warn",
      "dmarc-testing": "warn",
      "dmarc-reports": "warn",
      "dkim-key-0-acme.example-s1": "warn",
      "dkim-key-0-acme.example-s1-sha1": "fail",
      // s1 passes, so a retired or missing extra key only adds noise.
      "dkim-key-1-acme.example-old": "warn",
      "dkim-key-2-acme.example-gone": "warn",
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
    const pictureOnly = email({
      html: '<a href="https://acme.example/sale"><img src="sale.png"></a>',
    });
    expect(byId(report(pictureOnly).findings).images).toBe("warn");
    // A logo and a tracking pixel above a short sign-in code is ordinary mail.
    const signIn = email({
      html: '<img src="logo.png" width="120"><p>Your sign-in code is 482913. It expires in 10 minutes.</p><img src="https://t.example/o.gif" width="1" height="1">',
    });
    expect(byId(report(signIn).findings).images).toBe("pass");

    // File and product names are not addresses; a bare domain is.
    const names = email({
      html: [
        '<a href="https://cdn.files.example/x/invoice.pdf">invoice.pdf</a>',
        '<a href="https://nodejs.org/">Node.js</a>',
        `<p>${"words ".repeat(50)}</p>`,
      ].join(""),
    });
    expect(byId(report(names).findings)["links-text"]).toBeUndefined();
    const bare = email({
      html: `<a href="https://login.evil.example/">paypal.com</a><p>${"words ".repeat(50)}</p>`,
    });
    expect(byId(report(bare).findings)["links-text"]).toBe("warn");

    const large = email({ html: `<p>${"x".repeat(110 * 1024)}</p>` });
    expect(byId(report(large).findings).size).toBe("warn");
  });

  it("reports a DMARC failure that no mechanism aligned with", () => {
    // SPF failed and no signature passed: mail-auth's verdict is fail.
    const capture = email();
    capture.auth!.spf = { result: "fail", domain: "acme.example" };
    capture.auth!.dkim = [];
    capture.auth!.dmarc = {
      result: "fail",
      domain: "acme.example",
      policy: "reject",
      reason: null,
      spf: "none",
      dkim: "none",
    };
    const ids = byId(report(capture).findings);
    expect(ids).toMatchObject({ alignment: "fail", "dmarc-policy": "pass", "dkim-signed": "fail" });
    expect(ids["dmarc-record"]).toBeUndefined();
  });

  it("judges the policy that applies to a subdomain", () => {
    const capture = email({ from: [{ name: null, address: "news@news.acme.example" }] });
    capture.auth!.dmarc = { ...capture.auth!.dmarc!, domain: "news.acme.example", policy: "none" };
    // _dmarc.acme.example: p=reject; sp=none
    capture.auth!.setup = setup({
      dmarc: { ...setup().dmarc!, sp: "none" },
      bimi: { found: true, domain: "acme.example", logo: true, authority: true, error: null },
    });
    const findings = report(capture).findings;
    expect(byId(findings)).toMatchObject({ "dmarc-policy": "warn", bimi: "warn" });
    expect(findings.find((f) => f.id === "dmarc-policy")?.detail).toContain("for subdomains");
  });

  it("calls an unreadable record invalid, not missing", () => {
    const capture = email();
    capture.auth!.setup = setup({ dmarc: null });
    capture.auth!.dmarc = {
      result: "permerror",
      domain: "acme.example",
      policy: "unspecified",
      reason: null,
      spf: "permerror",
      dkim: "permerror",
    };
    const ids = byId(report(capture).findings);
    expect(ids["dmarc-record"]).toBe("fail");
    expect(report(capture).findings.find((f) => f.id === "dmarc-record")?.title).toBe(
      "DMARC record is invalid"
    );
    expect(ids.alignment).toBeUndefined();
  });

  it("does not guess on older mail whose DMARC result was ambiguous", () => {
    const old = email();
    old.auth = {
      ...old.auth!,
      setup: null,
      dkim: [],
      spf: { result: "softfail", domain: "acme.example" },
    };
    old.auth.dmarc = { result: "none", domain: "acme.example", policy: null, reason: null };
    expect(byId(report(old).findings)["dmarc-record"]).toBeUndefined();
  });

  it("tells skipped and unreachable apart from missing", () => {
    const skipped = email();
    skipped.auth!.dkim = [];
    skipped.auth!.dmarc = {
      result: "skipped",
      domain: null,
      policy: null,
      reason: "too many DKIM signatures",
    };
    expect(byId(report(skipped).findings)["dkim-signed"]).toBeUndefined();

    const unreachable = email();
    unreachable.auth!.setup = setup({
      dkim: [{ ...setup().dkim[0], key: null, bits: null, error: "lookup failed" }],
    });
    expect(byId(report(unreachable).findings)["dkim-key-0-acme.example-s1"]).toBe("info");
  });

  it("names includes without an SPF record", () => {
    const capture = email();
    capture.auth!.setup = setup({
      spf: { ...setup().spf!, missingIncludes: ["_spf.gone.example"] },
    });
    const finding = report(capture).findings.find((f) => f.id === "spf-includes");
    expect(finding?.status).toBe("fail");
    expect(finding?.detail).toContain("_spf.gone.example");
  });

  it("covers broken includes, failing signatures, country domains and image sizes", () => {
    // Includes with two records, and a lookup count that a failed nested
    // lookup left short.
    const spf = email();
    spf.auth!.setup = setup({
      spf: {
        ...setup().spf!,
        duplicateIncludes: ["_spf.two.example"],
        lookups: 4,
        lookupsIncomplete: true,
      },
    });
    const spfFindings = report(spf).findings;
    expect(byId(spfFindings)).toMatchObject({ "spf-includes": "fail", "spf-lookups": "info" });
    expect(spfFindings.find((f) => f.id === "spf-includes")?.detail).toContain(
      "_spf.two.example publishes more than one"
    );
    expect(spfFindings.find((f) => f.id === "spf-lookups")?.detail).toContain("at least 4");

    // A signature that does not verify is a finding of its own.
    const failed = email();
    failed.auth!.dkim = [{ result: "fail", domain: "acme.example", selector: "s1" }];
    expect(byId(report(failed).findings)["dkim-signature-0-acme.example-s1"]).toBe("fail");
    const extra = email();
    extra.auth!.dkim = [
      { result: "pass", domain: "acme.example", selector: "s1" },
      { result: "fail", domain: "esp.example", selector: "k1" },
    ];
    expect(byId(report(extra).findings)["dkim-signature-1-esp.example-k1"]).toBe("warn");

    // Country suffixes keep two different sites apart.
    const uk = email({
      html: `<a href="https://attacker.co.uk/login">paypal.co.uk</a><a href="https://www.acme.co.uk/">acme.co.uk</a><p>${"words ".repeat(50)}</p>`,
    });
    const ukFinding = report(uk).findings.find((f) => f.id === "links-text");
    expect(ukFinding?.detail).toContain("paypal.co.uk goes to attacker.co.uk");
    expect(ukFinding?.detail).not.toContain("acme.co.uk goes");

    // data-width and ?width= are not the image's size.
    const sized = email({
      html: '<img src="a.png?width=1" data-width="1"><img src="b.png?h=1&width=1"><p>Sale</p>',
    });
    expect(byId(report(sized).findings).images).toBe("warn");
  });

  it("keeps findings apart and explains each cause once", () => {
    // Two unparseable signatures get two findings, not one shared id.
    const twice = email();
    twice.auth!.dkim = [
      { result: "permerror", domain: null, selector: null },
      { result: "permerror", domain: null, selector: null },
    ];
    const ids = report(twice).findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith("dkim-signature-"))).toHaveLength(2);

    // A signature that fails because its key is gone is the key's finding.
    const gone = email();
    gone.auth!.dkim = [{ result: "permerror", domain: "acme.example", selector: "s1" }];
    gone.auth!.setup = setup({ dkim: [{ ...setup().dkim[0], key: null, bits: null }] });
    const goneIds = byId(report(gone).findings);
    expect(goneIds["dkim-key-0-acme.example-s1"]).toBe("fail");
    expect(goneIds["dkim-signature-0-acme.example-s1"]).toBeUndefined();
  });

  it("judges an SPF count with macro includes on what was counted", () => {
    const macro = email();
    macro.auth!.setup = setup({ spf: { ...setup().spf!, lookups: 2, lookupsUnfollowed: true } });
    const finding = report(macro).findings.find((f) => f.id === "spf-lookups");
    expect(finding).toMatchObject({ status: "pass", title: "SPF takes at least 2 DNS lookups" });
    expect(finding?.detail).toContain("macros");
    const close = email();
    close.auth!.setup = setup({ spf: { ...setup().spf!, lookups: 9, lookupsUnfollowed: true } });
    expect(byId(report(close).findings)["spf-lookups"]).toBe("warn");
  });

  it("names the subdomain policy only when it is the record's sp", () => {
    // t=y lowered reject to quarantine on the From domain itself.
    const testing = email();
    testing.auth!.dmarc!.policy = "quarantine";
    testing.auth!.setup = setup({ dmarc: { ...setup().dmarc!, testing: true } });
    const detail = report(testing).findings.find((f) => f.id === "dmarc-policy")?.detail;
    expect(detail).not.toContain("subdomains");
  });

  it("reads bounces, unreadable dates and addresses as link text fairly", () => {
    const bounce = email();
    bounce.smtp = { ...bounce.smtp!, envelopeFrom: null };
    bounce.auth!.setup = setup({
      spf: { ...setup().spf!, domain: "mail.acme.example", records: 0 },
    });
    const spfFinding = report(bounce).findings.find((f) => f.id === "spf-record");
    expect(spfFinding?.status).toBe("warn");
    expect(spfFinding?.title).toBe("No SPF record for the HELO name");

    const badDate = email({ date: null });
    const dateFinding = report(badDate, { date: "yesterday-ish" }).findings.find(
      (f) => f.id === "date"
    );
    expect(dateFinding).toMatchObject({ status: "warn", title: "Unreadable Date header" });
    expect(byId(report(email({ date: null })).findings).date).toBe("fail");

    const address = email({
      html: `<a href="https://acme.zendesk.example/hc">support@acme.com</a><p>${"words ".repeat(50)}</p>`,
    });
    expect(byId(report(address).findings)["links-text"]).toBeUndefined();
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
