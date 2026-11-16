import { createHmac } from "node:crypto";
import {
  verifyForwardedRequest,
  verifyRelayedRequest,
  verifyStandardWebhookSignature,
} from "@webhooks-cc/sdk";
import { describe, expect, it } from "vitest";
import type { RequestRecord } from "@/lib/supabase/requests";
import {
  deliveryTarget,
  filterVerdict,
  holdChat,
  isStaleHeadsUp,
  nextRetry,
  outgoingFor,
  reserveChatSlot,
  type OutgoingSettings,
} from "./worker";

const SECRET = `whsec_${Buffer.alloc(24, 7).toString("base64")}`;

function captured(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: "6b3f2c1e-0000-4000-8000-000000000001",
    endpointId: "e1",
    method: "POST",
    path: "/stripe/events",
    headers: { "content-type": "application/json", "stripe-signature": "t=1760109909,v1=abc" },
    body: '{"id":"evt","publishedAt":"2026-10-10T15:25:09.115Z"}',
    queryParams: {},
    queryRaw: "a=1",
    ip: "203.0.113.9",
    size: 12,
    receivedAt: Date.parse("2026-10-10T15:25:09.312Z"),
    kind: "http",
    ...overrides,
  };
}

function settings(overrides: Partial<OutgoingSettings> = {}): OutgoingSettings {
  return {
    url: "https://dest.example/hooks?token=x",
    format: null,
    appendPath: true,
    slug: "order-events",
    name: null,
    showEmailExtracts: true,
    ownerHeaders: [],
    attempt: 1,
    secret: SECRET,
    sentField: "publishedAt",
    ...overrides,
  };
}

describe("outgoingFor", () => {
  it("relays as received and records the target without the query", () => {
    const prepared = outgoingFor(captured(), settings());
    expect("outgoing" in prepared && prepared.outgoing.mode).toBe("relay");
    expect(prepared.facts).toMatchObject({
      format: "as_received",
      target: "dest.example/hooks/stripe/events",
      sent: { source: "publishedAt", wholeSeconds: false },
    });
  });

  it("sends HTTP requests as signed JSON when picked, through relay mode with owner headers", () => {
    const prepared = outgoingFor(
      captured(),
      settings({ format: "json", ownerHeaders: [["authorization", "Bearer t"]] })
    );
    if (!("outgoing" in prepared)) throw new Error(prepared.reason);
    expect(prepared.outgoing.method).toBe("POST");
    expect(prepared.outgoing.mode).toBe("relay");
    const headers = Object.fromEntries(prepared.outgoing.headers);
    expect(headers["webhook-signature"]).toMatch(/^v1,/);
    expect(headers.authorization).toBe("Bearer t");
    const json = JSON.parse(prepared.outgoing.body!.toString("utf8"));
    expect(json).toMatchObject({
      type: "request.received",
      data: { method: "POST", path: "/stripe/events", query: "a=1", bodyBase64: null },
    });
    expect(prepared.facts.target).toBe("dest.example/hooks");
  });

  it("keeps forward mode for signed JSON without owner headers", () => {
    const prepared = outgoingFor(captured(), settings({ format: "json" }));
    expect("outgoing" in prepared && prepared.outgoing.mode).toBe("forward");
  });

  it("posts a chat message with the lag to Slack, naming only the host", () => {
    const url = "https://hooks.slack.com/services/T0/B0/secret";
    const prepared = outgoingFor(captured(), settings({ url }));
    if (!("outgoing" in prepared)) throw new Error(prepared.reason);
    expect(prepared.facts).toMatchObject({ format: "chat", target: "hooks.slack.com" });
    const payload = JSON.parse(prepared.outgoing.body!.toString("utf8"));
    expect(payload.text).toContain("197 ms after publishedAt");
  });

  it("keeps a captured path with dot segments under the URL's path", () => {
    const prepared = outgoingFor(captured({ path: "/../../admin" }), settings());
    expect(prepared.facts.target).toBe("dest.example/hooks/admin");
  });
});

describe("email shapes and fields", () => {
  const capturedEmail = () =>
    captured({
      method: "EMAIL",
      path: "acme-orders+inv@mailhooks.cc",
      kind: "email",
      headers: { from: "Acme <billing@acme.example>", subject: "Invoice INV-2041" },
      body: "From: Acme <billing@acme.example>\r\nSubject: Invoice INV-2041\r\n\r\nPaid.",
      email: {
        subject: "Invoice INV-2041",
        from: [{ name: "Acme", address: "billing@acme.example" }],
        to: [{ name: null, address: "acme-orders+inv@mailhooks.cc" }],
        cc: [],
        replyTo: [],
        sender: [],
        date: null,
        messageId: null,
        inReplyTo: [],
        tag: "inv",
        text: "Paid.",
        html: null,
        textFromHtml: false,
        attachments: [],
        auth: null,
        smtp: null,
        parseError: false,
        truncated: {
          raw: false,
          text: false,
          html: false,
          headers: false,
          addresses: false,
          attachments: false,
        },
      },
    });
  const fields = [{ name: "invoice", from: "subject" as const, pattern: "(INV-\\d+)" }];

  it("sends an email as a provider would, signed with the destination's secret too", () => {
    const prepared = outgoingFor(capturedEmail(), settings({ format: "postmark" }));
    if (!("outgoing" in prepared)) throw new Error(prepared.reason);
    const headers = Object.fromEntries(prepared.outgoing.headers);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["webhook-signature"]).toMatch(/^v1,/);
    expect(JSON.parse(prepared.outgoing.body!.toString()).MailboxHash).toBe("inv");
    expect(prepared.facts.format).toBe("postmark");
  });

  it("relays HTTP requests to a provider-shaped destination as received", () => {
    const prepared = outgoingFor(captured(), settings({ format: "sendgrid" }));
    expect(prepared.facts.format).toBe("as_received");
  });

  it("signs a Mailgun form with the owner's key", () => {
    const prepared = outgoingFor(
      capturedEmail(),
      settings({ format: "mailgun", mailgunSigningKey: "key-acme" })
    );
    if (!("outgoing" in prepared)) throw new Error(prepared.reason);
    const form = new URLSearchParams(prepared.outgoing.body!.toString());
    const expected = createHmac("sha256", "key-acme")
      .update(`${form.get("timestamp")}${form.get("token")}`)
      .digest("hex");
    expect(form.get("signature")).toBe(expected);
  });

  describe("binary attachments in the forms", () => {
    // A PDF's first bytes and a byte no UTF-8 text has: carried as they are.
    const pdf = Buffer.from([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0xfe, 0x00,
    ]);
    const withFiles = () => {
      const email = capturedEmail();
      email.email!.attachments = [
        {
          filename: "invoice.pdf",
          contentType: "application/pdf",
          size: pdf.byteLength,
          contentId: null,
          inline: false,
          content: pdf.toString("base64"),
        },
        {
          filename: "lines.csv",
          contentType: "text/csv",
          size: 8,
          contentId: null,
          inline: false,
          content: Buffer.from("sku,qty\n").toString("base64"),
        },
      ];
      return email;
    };

    it.each(["sendgrid", "mailgun"] as const)(
      "%s carries a PDF as its exact bytes, signed over those bytes",
      (format) => {
        const prepared = outgoingFor(withFiles(), settings({ format }));
        if (!("outgoing" in prepared)) throw new Error(prepared.reason);
        const { outgoing } = prepared;
        expect(outgoing.mode).toBe("forward");
        const body = outgoing.body!;
        expect(body.includes(pdf)).toBe(true);
        expect(body.includes(Buffer.from("sku,qty\n"))).toBe(true);
        expect(body.includes(Buffer.from('filename="invoice.pdf"'))).toBe(true);
        expect(body.toString("latin1")).not.toContain(pdf.toString("base64"));

        const headers = Object.fromEntries(outgoing.headers);
        expect(headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
        const signed = Buffer.concat([
          Buffer.from(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.`),
          body,
        ]);
        const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
        const expected = createHmac("sha256", key).update(signed).digest("base64");
        expect(headers["webhook-signature"]).toBe(`v1,${expected}`);
      }
    );

    it("verifies with the SDK over the raw bytes, never over the text", async () => {
      const prepared = outgoingFor(withFiles(), settings({ format: "sendgrid" }));
      if (!("outgoing" in prepared)) throw new Error(prepared.reason);
      const body = prepared.outgoing.body!;
      const headers = Object.fromEntries(prepared.outgoing.headers);
      expect(await verifyStandardWebhookSignature(body, headers, SECRET)).toBe(true);
      expect(await verifyStandardWebhookSignature(body.toString("utf8"), headers, SECRET)).toBe(
        false
      );
    });

    it("sends the bytes through relay mode with the owner's headers", () => {
      const prepared = outgoingFor(
        withFiles(),
        settings({ format: "sendgrid", ownerHeaders: [["x-acme", "1"]] })
      );
      if (!("outgoing" in prepared)) throw new Error(prepared.reason);
      expect(prepared.outgoing.mode).toBe("relay");
      expect(prepared.outgoing.body!.includes(pdf)).toBe(true);
    });

    it("keeps the JSON shapes' bytes and signature as they were", () => {
      const prepared = outgoingFor(withFiles(), settings({ format: "postmark" }));
      if (!("outgoing" in prepared)) throw new Error(prepared.reason);
      const text = prepared.outgoing.body!.toString("utf8");
      const json = JSON.parse(text);
      expect(json.Attachments[0]).toMatchObject({
        Name: "invoice.pdf",
        Content: pdf.toString("base64"),
      });
      const headers = Object.fromEntries(prepared.outgoing.headers);
      const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
      const expected = createHmac("sha256", key)
        .update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${text}`)
        .digest("base64");
      expect(headers["webhook-signature"]).toBe(`v1,${expected}`);
    });
  });

  it("fills in the endpoint's fields in templates and the JSON", () => {
    const template = outgoingFor(
      capturedEmail(),
      settings({
        format: "template",
        bodyTemplate: { invoice: "{{ fields.invoice }}" },
        emailFields: fields,
      })
    );
    if (!("outgoing" in template)) throw new Error(template.reason);
    expect(JSON.parse(template.outgoing.body!.toString())).toEqual({ invoice: "INV-2041" });
    const json = outgoingFor(capturedEmail(), settings({ format: "json", emailFields: fields }));
    if (!("outgoing" in json)) throw new Error(json.reason);
    const data = JSON.parse(json.outgoing.body!.toString()).data;
    expect(data.fields).toEqual({ invoice: "INV-2041" });
    expect(data.replyText).toBeNull();
  });

  it("filters on a field", () => {
    const filter = {
      conditions: [{ field: "email_field", name: "invoice", op: "starts_with", value: "INV-" }],
    };
    expect(filterVerdict(filter, capturedEmail(), null, Date.now(), { invoice: "INV-2041" })).toBe(
      "send"
    );
    expect(filterVerdict(filter, capturedEmail(), null, Date.now(), { invoice: null })).toBe(
      "skip"
    );
  });
});

describe("deliveryTarget", () => {
  it("never keeps credentials or the query", () => {
    expect(deliveryTarget("https://u:p@dest.example:8443/x?y=1", "as_received")).toBe(
      "dest.example:8443/x"
    );
    expect(deliveryTarget("https://dest.example/", "json")).toBe("dest.example");
    expect(deliveryTarget("https://discord.com/api/webhooks/1/token", "as_received")).toBe(
      "discord.com"
    );
    expect(deliveryTarget("not a url", "json")).toBeNull();
  });
});

describe("nextRetry", () => {
  const queuedAt = new Date(0).toISOString();

  it("follows the schedule within the window", () => {
    expect(nextRetry(1, queuedAt, 86_400, 0)).toBe(30);
    expect(nextRetry(1, queuedAt, 0, 0)).toBeNull();
    expect(nextRetry(5, queuedAt, 3600, 2_550_000)).toBeNull();
  });

  it("waits as long as a throttled destination asks, never less than the schedule", () => {
    expect(nextRetry(1, queuedAt, 86_400, 0, 120)).toBe(120);
    expect(nextRetry(1, queuedAt, 86_400, 0, 1)).toBe(30);
    expect(nextRetry(1, queuedAt, 86_400, 0, 99_999)).toBe(3600);
    expect(nextRetry(8, queuedAt, 86_400, 0, 1)).toBe(43_200);
    expect(nextRetry(9, queuedAt, 86_400, 0, 1)).toBeNull();
    expect(nextRetry(1, queuedAt, 0, 0, 2)).toBeNull();
  });
});

describe("isStaleHeadsUp", () => {
  const queuedAt = "2026-10-25T12:00:00.000Z";
  const at = (seconds: number) => Date.parse(queuedAt) + seconds * 1000;
  const headsUp = {
    throttle_seconds: 1,
    forward_retry_seconds: 0,
    queued_at: queuedAt,
    bypass_filter: false,
  };

  it("drops a heads-up that could not go out within a minute", () => {
    expect(isStaleHeadsUp(headsUp, at(59))).toBe(false);
    expect(isStaleHeadsUp(headsUp, at(61))).toBe(true);
  });

  it("keeps whatever retries, is not throttled, or was asked for by hand", () => {
    expect(isStaleHeadsUp({ ...headsUp, forward_retry_seconds: 3600 }, at(600))).toBe(false);
    expect(isStaleHeadsUp({ ...headsUp, throttle_seconds: 0 }, at(600))).toBe(false);
    expect(isStaleHeadsUp({ ...headsUp, bypass_filter: true }, at(600))).toBe(false);
  });
});

describe("chat pacing", () => {
  it("spaces messages to one Slack webhook a second apart", () => {
    const url = `https://hooks.slack.com/services/T/B/${Math.random()}`;
    expect(reserveChatSlot(url, 0)).toEqual({ wait: 0 });
    expect(reserveChatSlot(url, 100)).toEqual({ wait: 900 });
    expect(reserveChatSlot(url, 1500)).toEqual({ wait: 500 });
  });

  it("sends a delivery back to the queue when the wait is long", () => {
    const url = `https://discord.com/api/webhooks/1/${Math.random()}`;
    holdChat(url, 30, 0);
    expect(reserveChatSlot(url, 1000)).toEqual({ retryInMs: 29_000 });
  });

  it("never holds other destinations", () => {
    const url = "https://dest.example/x";
    holdChat(url, 30, 0);
    expect(reserveChatSlot(url, 0)).toEqual({ wait: 0 });
    expect(reserveChatSlot(url, 0)).toEqual({ wait: 0 });
  });
});

describe("the SDK verifies what the worker sends", () => {
  it("as received: webhooks-cc-signature over the exact bytes", async () => {
    const body = Buffer.from([0x7b, 0x00, 0xff, 0x7d]);
    const prepared = outgoingFor(
      captured({ body: undefined, bodyRaw: body.toString("base64") }),
      settings()
    );
    if (!("outgoing" in prepared)) throw new Error(prepared.reason);
    const headers = Object.fromEntries(prepared.outgoing.headers);
    await expect(verifyRelayedRequest(prepared.outgoing.body!, headers, SECRET)).resolves.toEqual({
      requestId: "6b3f2c1e-0000-4000-8000-000000000001",
      receivedAt: "2026-10-10T15:25:09.312Z",
      endpoint: "order-events",
      attempt: 1,
    });
  });

  it("signed JSON: a request.received event with Standard Webhooks headers", async () => {
    const prepared = outgoingFor(captured(), settings({ format: "json" }));
    if (!("outgoing" in prepared)) throw new Error(prepared.reason);
    const event = await verifyForwardedRequest(
      prepared.outgoing.body!.toString("utf8"),
      Object.fromEntries(prepared.outgoing.headers),
      SECRET
    );
    expect(event.data).toMatchObject({ method: "POST", path: "/stripe/events", query: "a=1" });
  });
});
