import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebhooksCC } from "../client";
import { WebhookVerificationError } from "../errors";
import { REQUEST_RECEIVED } from "../types";
import { verifyForwardedRequest, verifyRelayedRequest } from "../verify";

const BASE_URL = "https://test.webhooks.cc";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe("client.forwarding, HTTP requests and the delivery log", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({ queued: 3 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const client = () =>
    new WebhooksCC({ apiKey: "whcc_testkey123", baseUrl: BASE_URL, retry: { maxAttempts: 1 } });

  it("maps every setting onto the endpoint update", async () => {
    await client().forwarding.configure("acme", {
      url: "https://hooks.slack.com/services/T/B/x",
      enabled: true,
      http: true,
      email: false,
      format: "chat",
      headers: [{ name: "Authorization", value: null }],
      appendPath: false,
      retrySeconds: 3600,
      keepOrder: true,
      sentField: "publishedAt",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      forwardUrl: "https://hooks.slack.com/services/T/B/x",
      forwardEnabled: true,
      forwardHttp: true,
      forwardEmail: false,
      forwardFormat: "chat",
      forwardHeaders: [{ name: "Authorization", value: null }],
      forwardAppendPath: false,
      forwardRetrySeconds: 3600,
      forwardKeepOrder: true,
      forwardSentField: "publishedAt",
    });
  });

  it("sends null to clear the sent field", async () => {
    await client().forwarding.configure("acme", { sentField: null });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ forwardSentField: null });
  });

  it("calls the log, summary, test and redelivery routes", async () => {
    const forwarding = client().forwarding;
    await forwarding.test("acme", { kind: "http" });
    await forwarding.deliveries("acme", {
      limit: 50,
      status: "failed",
      before: "2026-10-11T04:11:31.183+00:00|0b9e5f3a-6c1d-4f7e-9a2b-3c4d5e6f7a8b",
    });
    await forwarding.summary("acme");
    await forwarding.requestDeliveries("r1");
    await forwarding.redeliver("r1");
    await expect(forwarding.redeliverFailed("acme")).resolves.toEqual({ queued: 3 });

    const calls = fetchMock.mock.calls.map(([url, init]) => `${init.method} ${url}`);
    expect(calls).toEqual([
      `POST ${BASE_URL}/api/endpoints/acme/forwarding/test`,
      `GET ${BASE_URL}/api/endpoints/acme/deliveries?limit=50&status=failed&before=2026-10-11T04%3A11%3A31.183%2B00%3A00%7C0b9e5f3a-6c1d-4f7e-9a2b-3c4d5e6f7a8b`,
      `GET ${BASE_URL}/api/endpoints/acme/deliveries/summary`,
      `GET ${BASE_URL}/api/requests/r1/deliveries`,
      `POST ${BASE_URL}/api/requests/r1/deliveries`,
      `POST ${BASE_URL}/api/endpoints/acme/deliveries/redeliver-failed`,
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ kind: "http" });
  });

  it("keeps the old email name for request deliveries", async () => {
    await client().forwarding.emailDeliveries("e1");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/requests/e1/deliveries`);
  });
});

// The web app's scheme (apps/web/lib/forwarding/relay.ts): "v1," and the base64
// HMAC-SHA256 of "<request id>.<received at>." followed by the body bytes.
const secretBytes = Buffer.alloc(24, 7);
const secret = `whsec_${secretBytes.toString("base64")}`;
const requestId = "6b3f2c1e-0000-4000-8000-000000000001";
const receivedAt = "2026-10-10T15:25:09.231Z";

function relaySignature(body: Buffer, key = secretBytes, id = requestId): string {
  const mac = createHmac("sha256", key).update(`${id}.${receivedAt}.`).update(body).digest();
  return `v1,${mac.toString("base64")}`;
}

describe("verifyRelayedRequest", () => {
  const body = Buffer.from([0x7b, 0x00, 0xff, 0x7d]);
  const headers = {
    "webhooks-cc-request-id": requestId,
    "webhooks-cc-received-at": receivedAt,
    "webhooks-cc-endpoint": "order-events",
    "webhooks-cc-attempt": "2",
    "webhooks-cc-signature": relaySignature(body),
  };

  it("accepts the exact bytes and returns the metadata", async () => {
    await expect(verifyRelayedRequest(body, headers, secret)).resolves.toEqual({
      requestId,
      receivedAt,
      endpoint: "order-events",
      attempt: 2,
    });
    await expect(
      verifyRelayedRequest(new Uint8Array(body).buffer, new Headers(headers), secret)
    ).resolves.toMatchObject({ requestId });
  });

  it("accepts a text body", async () => {
    const text = '{"id":"evt_1"}';
    const signed = { ...headers, "webhooks-cc-signature": relaySignature(Buffer.from(text)) };
    await expect(verifyRelayedRequest(text, signed, secret)).resolves.toMatchObject({
      requestId,
    });
  });

  it("refuses a changed body, another secret or missing headers", async () => {
    await expect(verifyRelayedRequest(Buffer.from("{}"), headers, secret)).rejects.toMatchObject({
      code: "invalid_signature",
    });
    const other = `whsec_${Buffer.alloc(24, 8).toString("base64")}`;
    await expect(verifyRelayedRequest(body, headers, other)).rejects.toBeInstanceOf(
      WebhookVerificationError
    );
    const { "webhooks-cc-signature": _signature, ...unsigned } = headers;
    void _signature;
    await expect(verifyRelayedRequest(body, unsigned, secret)).rejects.toMatchObject({
      code: "missing_headers",
    });
  });
});

describe("verifyForwardedRequest", () => {
  const now = Date.parse("2026-10-11T10:00:00Z");
  const timestamp = Math.floor(now / 1000);
  const messageId = `msg_${requestId.replace(/-/g, "")}`;
  const event = {
    type: REQUEST_RECEIVED,
    timestamp: receivedAt,
    data: {
      id: requestId,
      endpoint: { slug: "order-events", name: null },
      receivedAt,
      method: "POST",
      path: "/stripe/events",
      query: "a=1",
      headers: { "content-type": "application/json" },
      contentType: "application/json",
      ip: "203.0.113.9",
      size: 12,
      body: '{"id":"evt"}',
      bodyBase64: null,
    },
  };

  function signed(payload: string) {
    const mac = createHmac("sha256", secretBytes)
      .update(`${messageId}.${timestamp}.${payload}`)
      .digest("base64");
    return {
      "webhook-id": messageId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": `v1,${mac}`,
    };
  }

  it("returns the request.received event", async () => {
    const body = JSON.stringify(event);
    const verified = await verifyForwardedRequest(body, signed(body), secret, { now });
    expect(verified.data).toMatchObject({ method: "POST", path: "/stripe/events" });
  });

  it("refuses an email or other JSON with a valid signature", async () => {
    const body = JSON.stringify({ type: "email.received", timestamp: receivedAt, data: {} });
    await expect(verifyForwardedRequest(body, signed(body), secret, { now })).rejects.toMatchObject(
      { code: "invalid_payload" }
    );
  });

  it("refuses an old timestamp", async () => {
    const body = JSON.stringify(event);
    await expect(
      verifyForwardedRequest(body, signed(body), secret, { now: now + 600_000 })
    ).rejects.toMatchObject({ code: "timestamp_out_of_range" });
  });
});
