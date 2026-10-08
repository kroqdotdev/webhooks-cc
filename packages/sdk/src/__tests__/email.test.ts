import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebhooksCC } from "../client";
import { NotFoundError, TimeoutError, WebhookVerificationError } from "../errors";
import {
  buildEmailJson,
  emailAddress,
  extractCode,
  extractLink,
  isValidEmailTag,
  type EmailCapture,
} from "../email";
import { isEmailRequest, matchAll, matchEmail } from "../matchers";
import { detectWebhookInfo } from "../helpers";
import { captureEmailDuring } from "../testing";
import { verifyForwardedEmail, verifyStandardWebhookSignature } from "../verify";
import type { Request } from "../types";

const BASE_URL = "https://test.webhooks.cc";

function createClient() {
  return new WebhooksCC({
    apiKey: "whcc_testkey123",
    baseUrl: BASE_URL,
    retry: { maxAttempts: 1 },
  });
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function capture(overrides: Partial<EmailCapture> = {}): EmailCapture {
  return {
    subject: "Confirm your email for Tidewater",
    from: [{ name: "Tidewater", address: "no-reply@tidewater.app" }],
    to: [{ name: null, address: "acme+run-1@mailhooks.cc" }],
    cc: [],
    replyTo: [],
    sender: [],
    date: "2026-10-08T09:30:00.000Z",
    messageId: "abc@tidewater.app",
    inReplyTo: [],
    tag: "run-1",
    text: "Your confirmation code is 482913.\n\nConfirm: https://app.tidewater.app/confirm?token=Zk3q9v\n",
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
    ...overrides,
  };
}

function emailRequest(
  id: string,
  overrides: Partial<EmailCapture> = {},
  receivedAt = Date.now()
): Request {
  const email = capture(overrides);
  return {
    id,
    endpointId: "ep_1",
    method: "EMAIL",
    path: email.tag ? `acme+${email.tag}@mailhooks.cc` : "acme@mailhooks.cc",
    headers: { subject: email.subject ?? "" },
    body: "raw message",
    queryParams: {},
    ip: "203.0.113.5",
    size: 1200,
    receivedAt,
    kind: "email",
    email,
  };
}

const httpRequest: Request = {
  id: "http_1",
  endpointId: "ep_1",
  method: "POST",
  path: "/hooks",
  headers: { "content-type": "application/json" },
  body: '{"ok":true}',
  queryParams: {},
  ip: "203.0.113.5",
  size: 11,
  receivedAt: Date.now(),
  kind: "http",
};

describe("email helpers", () => {
  it("builds addresses and validates tags like the mail server", () => {
    expect(emailAddress("Acme")).toBe("acme@mailhooks.cc");
    expect(emailAddress("acme", "run-42")).toBe("acme+run-42@mailhooks.cc");
    expect(emailAddress("acme", "a.b_c=d", "dev.mailhooks.cc")).toBe(
      "acme+a.b_c=d@dev.mailhooks.cc"
    );
    expect(isValidEmailTag("has space")).toBe(false);
    expect(isValidEmailTag("at@sign")).toBe(false);
    expect(isValidEmailTag("x".repeat(64))).toBe(true);
    expect(isValidEmailTag("x".repeat(60), "acme")).toBe(false);
    expect(() => emailAddress("acme", "bad tag")).toThrow(/Invalid email tag/);
    expect(() => emailAddress("not/a/slug")).toThrow(/Invalid endpoint slug/);
  });

  it("extracts the code and the action link from an email or a request", () => {
    const request = emailRequest("e1");
    expect(extractCode(request)).toBe("482913");
    expect(extractCode(request.email!)).toBe("482913");
    expect(extractLink(request)).toBe("https://app.tidewater.app/confirm?token=Zk3q9v");
    expect(extractCode({ subject: "Hello", text: "Nothing here", html: null })).toBeNull();
    const plain = { subject: "News", text: "Read https://example.com/post", html: null };
    expect(extractLink(plain)).toBe("https://example.com/post");
    expect(extractLink(plain, { actionOnly: true })).toBeNull();
    expect(extractLink(request, { actionOnly: true })).toBe(
      "https://app.tidewater.app/confirm?token=Zk3q9v"
    );
    expect(extractCode(httpRequest)).toBeNull();
  });

  it("builds email.received JSON with or without extracts", () => {
    const request = emailRequest("e1");
    const source = { ...request, email: request.email! };
    const withExtracts = buildEmailJson(source, { slug: "acme" });
    expect(withExtracts.type).toBe("email.received");
    expect(withExtracts.data.codes).toEqual(["482913"]);
    expect(withExtracts.data.endpoint).toEqual({ slug: "acme", name: null });
    const without = buildEmailJson(source, { slug: "acme" }, { includeExtracts: false });
    expect("codes" in without.data).toBe(false);
    expect("links" in without.data).toBe(false);
  });

  it("does not run provider detection on emails", () => {
    const request = emailRequest("e1");
    request.headers = { "stripe-signature": "t=1,v1=abc" };
    expect(detectWebhookInfo(request)).toBeNull();
  });
});

describe("email matchers", () => {
  it("recognises emails by kind, and by method and path from older servers", () => {
    expect(isEmailRequest(emailRequest("e1"))).toBe(true);
    expect(isEmailRequest(httpRequest)).toBe(false);
    const legacy = { ...emailRequest("e2"), kind: undefined };
    expect(isEmailRequest(legacy)).toBe(true);
    // A custom EMAIL method over HTTP has a URL path and no parsed email.
    expect(isEmailRequest({ ...httpRequest, method: "EMAIL", kind: undefined })).toBe(false);
  });

  it("matches tag, subject, sender and recipient", () => {
    const request = emailRequest("e1");
    expect(matchEmail({ tag: "run-1" })(request)).toBe(true);
    expect(matchEmail({ tag: "run-2" })(request)).toBe(false);
    expect(matchEmail({ tag: null })(request)).toBe(false);
    expect(matchEmail({ tag: null })(emailRequest("e2", { tag: null }))).toBe(true);
    expect(matchEmail({ subject: "Confirm your" })(request)).toBe(true);
    expect(matchEmail({ subject: /^confirm/i })(request)).toBe(true);
    expect(matchEmail({ subject: "Reset" })(request)).toBe(false);
    expect(matchEmail({ from: "NO-REPLY@tidewater.app" })(request)).toBe(true);
    expect(matchEmail({ from: /^Tidewater </ })(request)).toBe(true);
    expect(matchEmail({ to: "acme+run-1@mailhooks.cc" })(request)).toBe(true);
    expect(matchEmail()(httpRequest)).toBe(false);
    expect(
      matchAll(matchEmail({ tag: "run-1" }), matchEmail({ subject: "Confirm" }))(request)
    ).toBe(true);
  });

  it("resets a global RegExp between matches", () => {
    const pattern = /confirm/gi;
    const match = matchEmail({ subject: pattern });
    expect(match(emailRequest("e1"))).toBe(true);
    expect(match(emailRequest("e2"))).toBe(true);
  });
});

describe("client.emails", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("lists emails with kind=email and filters by criteria", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([
          emailRequest("e1", { tag: "run-1" }),
          emailRequest("e2", { tag: "run-2" }),
          httpRequest,
        ])
      );
    globalThis.fetch = fetchMock;

    const emails = await createClient().emails.list("acme", { tag: "run-2", since: 1000 });
    expect(emails.map((email) => email.id)).toEqual(["e2"]);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/api/endpoints/acme/requests");
    expect(url.searchParams.get("kind")).toBe("email");
    expect(url.searchParams.get("since")).toBe("1000");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("waits for a matching email and ignores others", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([emailRequest("e1", { tag: "other" })]))
      .mockResolvedValueOnce(
        jsonResponse([emailRequest("e1", { tag: "other" }), emailRequest("e2", { tag: "run-9" })])
      );
    globalThis.fetch = fetchMock;

    const email = await createClient().emails.waitFor("acme", {
      tag: "run-9",
      pollInterval: 10,
      timeout: 2000,
    });
    expect(email.id).toBe("e2");
    expect(email.email.tag).toBe("run-9");
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("kind")).toBe("email");
  });

  it("uses the given since instead of the five-minute lookback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([emailRequest("e1")]));
    globalThis.fetch = fetchMock;

    await createClient().emails.waitFor("acme", { since: 1234, pollInterval: 10 });
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("since")).toBe("1234");
  });

  it("times out when no email matches", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse([httpRequest]));
    await expect(
      createClient().emails.waitFor("acme", { timeout: 60, pollInterval: 10 })
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("gets one email and refuses HTTP requests", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(emailRequest("e1")))
      .mockResolvedValueOnce(jsonResponse(httpRequest));
    const client = createClient();
    expect((await client.emails.get("e1")).email.subject).toContain("Confirm");
    await expect(client.emails.get("http_1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns the newest matching email or null", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([emailRequest("old", {}, 1000), emailRequest("new", {}, 2000)])
      )
      .mockResolvedValueOnce(jsonResponse([]));
    const client = createClient();
    expect((await client.emails.latest("acme"))?.id).toBe("new");
    expect(await client.emails.latest("acme")).toBeNull();
  });

  it("sends a test email, with a validated tag", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "captured", requestId: "e1" }));
    globalThis.fetch = fetchMock;

    const client = createClient();
    await expect(client.emails.sendTest("acme", { tag: "run-1" })).resolves.toEqual({
      status: "captured",
      requestId: "e1",
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/send-test-email`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ slug: "acme", tag: "run-1" });
    await expect(client.emails.sendTest("acme", { tag: "no spaces" })).rejects.toThrow(
      /Invalid email tag/
    );
  });

  it("builds addresses from the endpoint the server reports", () => {
    const client = createClient();
    const endpoint = { slug: "acme", emailAddress: "acme@dev.mailhooks.cc" };
    expect(client.emails.address(endpoint)).toBe("acme@dev.mailhooks.cc");
    expect(client.emails.address(endpoint, "t1")).toBe("acme+t1@dev.mailhooks.cc");
    expect(client.emails.address("acme", "t1")).toBe("acme+t1@mailhooks.cc");
    const custom = new WebhooksCC({ apiKey: "whcc_x", emailDomain: "example.test" });
    expect(custom.emails.address("acme")).toBe("acme@example.test");
  });

  it("turns an email into the JSON forwarding would post", () => {
    const json = createClient().emails.toJson(emailRequest("e1") as never);
    expect(json.type).toBe("email.received");
    expect(json.data.endpoint.slug).toBe("acme");
    expect(json.data.tag).toBe("run-1");
    expect(json.data.codes).toEqual(["482913"]);
  });

  it("refuses to replay an email as an HTTP request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(emailRequest("e1")));
    globalThis.fetch = fetchMock;
    await expect(
      createClient().requests.replay("e1", "http://localhost:3000/hooks")
    ).rejects.toThrow(/captured email/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exports only HTTP requests", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "ep_1", slug: "acme", createdAt: 1 }))
      .mockResolvedValueOnce(
        jsonResponse({ items: [httpRequest, emailRequest("e1")], hasMore: false })
      );
    const curl = (await createClient().requests.export("acme", { format: "curl" })) as string[];
    expect(curl).toHaveLength(1);
    expect(curl[0]).toContain("curl -X POST");
  });
});

describe("client.forwarding", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({ secret: "whsec_abc" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls each forwarding route", async () => {
    const client = createClient();
    await client.forwarding.configure("acme", { url: "https://example.com/in", enabled: true });
    await client.forwarding.secret("acme");
    await client.forwarding.rotateSecret("acme");
    await client.forwarding.test("acme");
    await client.forwarding.deliveries("acme", { limit: 10 });
    await client.forwarding.emailDeliveries("e1");
    await client.forwarding.redeliver("e1");

    const calls = fetchMock.mock.calls.map(([url, init]) => `${init.method} ${url}`);
    expect(calls).toEqual([
      `PATCH ${BASE_URL}/api/endpoints/acme`,
      `GET ${BASE_URL}/api/endpoints/acme/forwarding`,
      `POST ${BASE_URL}/api/endpoints/acme/forwarding`,
      `POST ${BASE_URL}/api/endpoints/acme/forwarding/test`,
      `GET ${BASE_URL}/api/endpoints/acme/deliveries?limit=10`,
      `GET ${BASE_URL}/api/requests/e1/deliveries`,
      `POST ${BASE_URL}/api/requests/e1/deliveries`,
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      forwardUrl: "https://example.com/in",
      forwardEnabled: true,
    });
  });

  it("returns the secret and rejects an empty configure", async () => {
    const client = createClient();
    await expect(client.forwarding.secret("acme")).resolves.toBe("whsec_abc");
    await expect(client.forwarding.configure("acme", {})).rejects.toThrow(/url or enabled/);
  });
});

describe("captureEmailDuring", () => {
  it("hands the action the endpoint's address and waits from its creation", async () => {
    const endpoint = {
      id: "ep_1",
      slug: "acme",
      createdAt: 5000,
      emailAddress: "acme@mailhooks.cc",
    };
    const waitForAll = vi.fn().mockResolvedValue([emailRequest("e1")]);
    const client = {
      endpoints: {
        create: vi.fn().mockResolvedValue(endpoint),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      requests: {},
      emails: {
        address: (target: typeof endpoint, tag?: string) =>
          tag ? `acme+${tag}@mailhooks.cc` : target.emailAddress,
        waitForAll,
      },
    };
    const action = vi.fn();

    const emails = await captureEmailDuring(client as never, action, { tag: "run-1" });
    expect(emails).toHaveLength(1);
    expect(action).toHaveBeenCalledWith("acme+run-1@mailhooks.cc", endpoint);
    expect(waitForAll).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({ count: 1, since: 5000, tag: "run-1" })
    );
    expect(client.endpoints.delete).toHaveBeenCalledWith("acme");
  });
});

describe("verifyForwardedEmail", () => {
  // Same scheme as apps/web/lib/forwarding/sign.ts: v1, base64 HMAC-SHA256 of id.timestamp.body.
  const secretBytes = new Uint8Array(24).map((_, index) => index + 1);
  const secret = `whsec_${Buffer.from(secretBytes).toString("base64")}`;
  const now = Date.parse("2026-10-08T10:00:00Z");
  const timestamp = Math.floor(now / 1000);
  const email = emailRequest("0b9e5f3a-6c1d-4f7e-9a2b-3c4d5e6f7a8b");
  const body = JSON.stringify(buildEmailJson({ ...email, email: email.email! }, { slug: "acme" }));
  const messageId = "msg_0b9e5f3a6c1d4f7e9a2b3c4d5e6f7a8b";

  async function sign(payload: string, ts = timestamp): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${messageId}.${ts}.${payload}`)
    );
    return `v1,${Buffer.from(new Uint8Array(signature)).toString("base64")}`;
  }

  async function headers(payload = body, ts = timestamp) {
    return {
      "webhook-id": messageId,
      "webhook-timestamp": String(ts),
      "webhook-signature": await sign(payload, ts),
    };
  }

  it("accepts a Fetch Headers, a plain object, pairs and a byte body", async () => {
    const plain = await headers();
    const fromHeaders = await verifyForwardedEmail(body, new Headers(plain), secret, { now });
    expect(fromHeaders.data.codes).toEqual(["482913"]);
    await expect(verifyForwardedEmail(body, plain, secret, { now })).resolves.toBeTruthy();
    await expect(
      verifyForwardedEmail(body, Object.entries(plain), secret, { now })
    ).resolves.toBeTruthy();
    await expect(
      verifyForwardedEmail(new TextEncoder().encode(body), plain, secret, { now })
    ).resolves.toBeTruthy();
    // Node-style array values and mixed case
    await expect(
      verifyForwardedEmail(
        body,
        {
          "Webhook-Id": [messageId],
          "WEBHOOK-TIMESTAMP": String(timestamp),
          "webhook-signature": plain["webhook-signature"],
        },
        secret,
        { now }
      )
    ).resolves.toBeTruthy();
  });

  it("accepts any one of several signatures", async () => {
    const plain = await headers();
    plain["webhook-signature"] = `v1,AAAA ${plain["webhook-signature"]}`;
    await expect(verifyForwardedEmail(body, plain, secret, { now })).resolves.toBeTruthy();
  });

  it("rejects tampering, the wrong secret, old timestamps and missing headers", async () => {
    const plain = await headers();
    const reject = async (promise: Promise<unknown>, code: string) => {
      const error = await promise.then(
        () => null,
        (err: unknown) => err
      );
      expect(error).toBeInstanceOf(WebhookVerificationError);
      expect((error as WebhookVerificationError).code).toBe(code);
    };
    await reject(verifyForwardedEmail(body + " ", plain, secret, { now }), "invalid_signature");
    await reject(
      verifyForwardedEmail(
        body,
        plain,
        `whsec_${Buffer.from(new Uint8Array(24)).toString("base64")}`,
        { now }
      ),
      "invalid_signature"
    );
    await reject(
      verifyForwardedEmail(body, plain, secret, { now: now + 301_000 }),
      "timestamp_out_of_range"
    );
    await reject(
      verifyForwardedEmail(body, { "webhook-id": messageId }, secret, { now }),
      "missing_headers"
    );
    const notEmail = '{"type":"other"}';
    await reject(
      verifyForwardedEmail(notEmail, await headers(notEmail), secret, { now }),
      "invalid_payload"
    );
  });

  it("lets verifyStandardWebhookSignature read a Fetch Headers too", async () => {
    const plain = await headers();
    await expect(verifyStandardWebhookSignature(body, new Headers(plain), secret)).resolves.toBe(
      true
    );
  });
});
