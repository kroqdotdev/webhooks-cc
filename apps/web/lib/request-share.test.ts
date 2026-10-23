import { describe, expect, it } from "vitest";
import {
  buildShareSnapshot,
  parseShareSnapshot,
  redactHeaders,
  redactQuery,
  REDACTED,
  SHARE_BODY_LIMIT,
  snapshotToRequest,
  type ShareSource,
} from "./request-share";

const source: ShareSource = {
  method: "POST",
  path: "/hooks/stripe",
  headers: {
    "content-type": "application/json",
    Authorization: "Bearer sk_live_123",
    cookie: "session=abc",
    "stripe-signature": "t=1,v1=abc",
    "x-gitlab-token": "glt",
    "x-shopify-hmac-sha256": "mac",
    "x-request-id": "req_1",
  },
  queryParams: { code: "oauth-code", token: "t", page: "2" },
  body: '{"id":"evt_1"}',
  contentType: "application/json",
  size: 14,
  receivedAt: 1_700_000_000_000,
  detectedProvider: "stripe",
  detectedEvent: "invoice.paid",
  signatureVerified: true,
  signingProvider: "stripe",
};

describe("share redaction", () => {
  it("always hides credential headers", () => {
    const { values, redacted } = redactHeaders(source.headers, false);
    expect(redacted).toEqual(["Authorization", "cookie"]);
    expect(values.Authorization).toBe(REDACTED);
    expect(values["stripe-signature"]).toBe("t=1,v1=abc");
  });

  it("hides signatures, tokens and keys by default", () => {
    const { values, redacted } = redactHeaders(source.headers, true);
    expect(redacted).toEqual([
      "Authorization",
      "cookie",
      "stripe-signature",
      "x-gitlab-token",
      "x-shopify-hmac-sha256",
    ]);
    expect(values["content-type"]).toBe("application/json");
    expect(values["x-request-id"]).toBe("req_1");
  });

  it("hides one-time query values only when asked", () => {
    expect(redactQuery(source.queryParams, true).redacted).toEqual(["code", "token"]);
    expect(redactQuery(source.queryParams, false).redacted).toEqual([]);
  });
});

describe("share snapshot", () => {
  it("keeps what the page shows and nothing that identifies the sender", () => {
    const snapshot = buildShareSnapshot({ ...source, bodyRaw: "AAE=" }, { hideSensitive: true });
    expect(snapshot).toMatchObject({
      v: 1,
      method: "POST",
      path: "/hooks/stripe",
      body: '{"id":"evt_1"}',
      bodyTruncated: false,
      bodyNotUtf8: true,
      detectedEvent: "invoice.paid",
      redactedQuery: ["code", "token"],
    });
    expect(JSON.stringify(snapshot)).not.toContain("sk_live_123");
    expect(snapshot).not.toHaveProperty("ip");
  });

  it("hides function keys and identity assertions too", () => {
    const headers = {
      "x-functions-key": "k",
      "ocp-apim-subscription-key": "k",
      "cf-access-jwt-assertion": "j",
      "x-api-credential": "c",
      "content-length": "10",
    };
    expect(redactHeaders(headers, true).redacted).toEqual([
      "x-functions-key",
      "ocp-apim-subscription-key",
      "cf-access-jwt-assertion",
      "x-api-credential",
    ]);
  });

  it("never cuts an emoji in half", () => {
    const body = "x".repeat(SHARE_BODY_LIMIT - 1) + "\u{1F600}" + "tail";
    const snapshot = buildShareSnapshot({ ...source, body }, { hideSensitive: true });
    expect(snapshot.body).toHaveLength(SHARE_BODY_LIMIT - 1);
    expect(snapshot.bodyTruncated).toBe(true);
  });

  it("cuts long bodies and says so", () => {
    const snapshot = buildShareSnapshot(
      { ...source, body: "x".repeat(SHARE_BODY_LIMIT + 10) },
      { hideSensitive: true }
    );
    expect(snapshot.body).toHaveLength(SHARE_BODY_LIMIT);
    expect(snapshot.bodyTruncated).toBe(true);
  });

  it("round-trips through storage and refuses anything else", () => {
    const snapshot = buildShareSnapshot(source, { hideSensitive: true });
    expect(parseShareSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(parseShareSnapshot(null)).toBeNull();
    expect(parseShareSnapshot({ ...snapshot, v: 2 })).toBeNull();
    expect(parseShareSnapshot({ ...snapshot, headers: { a: 1 } })).toBeNull();
  });

  it("renders as an HTTP request without a sender address", () => {
    const request = snapshotToRequest(buildShareSnapshot(source, { hideSensitive: true }), "tok");
    expect(request).toMatchObject({ _id: "tok", kind: "http", ip: "", method: "POST" });
    expect(request.headers["stripe-signature"]).toBe(REDACTED);
  });
});
