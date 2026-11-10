import { describe, expect, it } from "vitest";
import { extractFromEmail } from "@webhooks-cc/sdk/email";
import type { RequestRecord } from "@/lib/supabase/requests";
import { LAYOUT_TEMPLATES, layoutTemplate } from "./layout-templates";
import { chooseLayout, layoutFieldValues } from "./parsing/layouts";
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

  it("names the site whose dashboard sent it", () => {
    const fromMail = buildTestEmail({
      to: "abc123@mailhooks.cc",
      appUrl: "https://webhooks.cc/",
      now,
      siteName: "mailhooks.cc",
    });
    expect(fromMail.raw).toContain("From: mailhooks.cc <test@webhooks.cc>\r\n");
    expect(fromMail.raw).toContain("Subject: Test email from mailhooks.cc\r\n");
    expect(fromMail.raw).toContain("This is a test email from your mailhooks.cc dashboard.");
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
      // What the dashboard trusts to call it a test, not the header.
      test: true,
    });
    expect(Buffer.from(body.raw, "base64").toString("utf8")).toBe(email.raw);
  });
});

/** Just enough MIME reading for the messages built here: headers, base64 parts, encoded words. */
function readMessage(raw: string) {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const unfolded = head.replace(/\r\n[ \t]+/g, " ");
  const header = (name: string) => new RegExp(`^${name}: (.*)$`, "mi").exec(unfolded)?.[1] ?? null;
  const decodeWords = (value: string) =>
    value.replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/g, (_m, b64: string) =>
      Buffer.from(b64, "base64").toString("utf8")
    );
  const body = rest.join("\r\n\r\n");
  const parts: Record<string, string> = {};
  const read = (partHead: string, partBody: string) => {
    const type = /Content-Type: text\/(plain|html)/i.exec(partHead)?.[1];
    expect(partHead).toContain("Content-Transfer-Encoding: base64");
    if (type) parts[type] = Buffer.from(partBody.replace(/\r\n/g, ""), "base64").toString("utf8");
  };
  const boundary = /boundary="([^"]+)"/.exec(head)?.[1];
  if (boundary) {
    for (const chunk of body.split(`--${boundary}`).slice(1, -1)) {
      const [partHead, ...partBody] = chunk.replace(/^\r\n/, "").split("\r\n\r\n");
      read(partHead, partBody.join("\r\n\r\n").replace(/\r\n$/, ""));
    }
  } else {
    read(head, body);
  }
  return {
    header,
    subject: decodeWords(header("Subject") ?? ""),
    text: parts.plain ?? null,
    html: parts.html ?? null,
  };
}

describe("buildTestEmail with a template", () => {
  const now = new Date("2026-10-08T09:30:00Z");

  it("sends the sample from the test address, naming the sender as a sample", () => {
    const template = layoutTemplate("shopify-orders")!;
    const email = buildTestEmail({
      to: "abc123@mailhooks.cc",
      appUrl: "https://webhooks.cc/",
      now,
      template,
    });
    expect(email.code).toBeNull();
    expect(email.raw).toContain('From: "Shopify (sample)" <test@webhooks.cc>\r\n');
    expect(email.raw).toContain("To: <abc123@mailhooks.cc>\r\n");
    expect(email.raw).toContain(`${TEST_EMAIL_HEADER}: 1\r\n`);
    expect(email.raw).not.toContain(template.sample.from.address);
    const read = readMessage(email.raw);
    expect(read.subject).toBe(template.sample.subject);
    // CRLF on the wire, like any mail; the layouts read either.
    expect(read.text).toBe(template.sample.text.replace(/\n/g, "\r\n"));
    expect(read.html).toBeNull();
    // The envelope sender stays the test address too.
    const body = JSON.parse(testDeliveryBody({ to: "abc123@mailhooks.cc", raw: email.raw, now }));
    expect(body.envelope_from).toBe("test@webhooks.cc");
  });

  it("sends the text and the HTML of a sample that has both", () => {
    const template = layoutTemplate("woocommerce-orders")!;
    const read = readMessage(
      buildTestEmail({ to: "a@mailhooks.cc", appUrl: "https://webhooks.cc", now, template }).raw
    );
    expect(read.header("Content-Type")).toMatch(/^multipart\/alternative; boundary=/);
    expect(read.html).toBe(template.sample.html);
    expect(read.text).toBe(template.sample.text.replace(/\n/g, "\r\n"));
  });

  it("encodes a subject that is not plain ASCII", () => {
    const template = {
      ...layoutTemplate("shopify-orders")!,
      sender: "Café Ünïcode",
      sample: {
        ...layoutTemplate("shopify-orders")!.sample,
        subject: "Bestellung № 1042 für Jörg, ".repeat(3).trim(),
      },
    };
    const raw = buildTestEmail({ to: "a@mailhooks.cc", appUrl: "x", now, template }).raw;
    const [head] = raw.split("\r\n\r\n");
    // Headers stay ASCII, with lines under 78 characters.
    expect(head).toMatch(/^[\r\n\x20-\x7e]*$/);
    for (const line of head.split("\r\n")) expect(line.length).toBeLessThan(78);
    expect(readMessage(raw).subject).toBe(template.sample.subject);
    expect(head).toContain("From: =?UTF-8?B?");
  });

  it.each(LAYOUT_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s: the layout reads its sample email as sent",
    (_id, template) => {
      const read = readMessage(
        buildTestEmail({ to: "a@mailhooks.cc", appUrl: "https://webhooks.cc", now, template }).raw
      );
      const request = {
        id: "r1",
        kind: "email",
        headers: { subject: read.subject },
        email: {
          subject: read.subject,
          text: read.text,
          html: read.html,
          from: [{ name: `${template.sender} (sample)`, address: "test@webhooks.cc" }],
          to: [{ name: null, address: "a@mailhooks.cc" }],
          cc: [],
          attachments: [],
        },
      } as unknown as RequestRecord;
      // Among all the templates' layouts, in their order, its own picks it.
      expect(
        chooseLayout(
          LAYOUT_TEMPLATES.map((t) => t.layout),
          50,
          request
        )?.id
      ).toBe(template.id);
      expect(layoutFieldValues(request, template.layout)).toEqual(template.result.fields);
    }
  );
});
