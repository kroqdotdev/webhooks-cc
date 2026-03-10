import { describe, it, expect } from "vitest";
import {
  parseJsonBody,
  parseFormBody,
  parseBody,
  extractJsonField,
  isStripeWebhook,
  isGitHubWebhook,
  isShopifyWebhook,
  isSlackWebhook,
  isTwilioWebhook,
  isPaddleWebhook,
  isLinearWebhook,
  isDiscordWebhook,
  isStandardWebhook,
} from "../helpers";
import type { Request } from "../types";

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: "r1",
    endpointId: "ep1",
    method: "POST",
    path: "/",
    headers: {},
    queryParams: {},
    ip: "127.0.0.1",
    size: 0,
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe("parseJsonBody", () => {
  it("parses valid JSON body", () => {
    expect(parseJsonBody(makeRequest({ body: '{"key":"value"}' }))).toEqual({ key: "value" });
  });

  it("returns undefined for empty body", () => {
    expect(parseJsonBody(makeRequest({ body: undefined }))).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseJsonBody(makeRequest({ body: "not json" }))).toBeUndefined();
  });
});

describe("parseFormBody", () => {
  it("parses urlencoded bodies", () => {
    expect(
      parseFormBody(
        makeRequest({
          body: "foo=bar&foo=baz&hello=world",
          contentType: "application/x-www-form-urlencoded",
        })
      )
    ).toEqual({
      foo: ["bar", "baz"],
      hello: "world",
    });
  });

  it("returns undefined for non-form content types", () => {
    expect(
      parseFormBody(
        makeRequest({
          body: '{"foo":"bar"}',
          contentType: "application/json",
        })
      )
    ).toBeUndefined();
  });
});

describe("parseBody", () => {
  it("parses JSON when content-type is application/json", () => {
    expect(
      parseBody(
        makeRequest({
          body: '{"foo":{"bar":42}}',
          contentType: "application/json; charset=utf-8",
        })
      )
    ).toEqual({ foo: { bar: 42 } });
  });

  it("parses form data when content-type is urlencoded", () => {
    expect(
      parseBody(
        makeRequest({
          body: "foo=bar&baz=qux",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        })
      )
    ).toEqual({ foo: "bar", baz: "qux" });
  });

  it("returns raw text for unsupported content types", () => {
    expect(
      parseBody(
        makeRequest({
          body: "<xml />",
          contentType: "application/xml",
        })
      )
    ).toBe("<xml />");
  });
});

describe("extractJsonField", () => {
  it("extracts nested JSON values using dot notation", () => {
    expect(
      extractJsonField<number>(
        makeRequest({
          body: '{"data":{"object":{"amount":4999}}}',
          contentType: "application/json",
        }),
        "data.object.amount"
      )
    ).toBe(4999);
  });

  it("supports array indexing and returns undefined for missing paths", () => {
    expect(
      extractJsonField<string>(
        makeRequest({
          body: '{"items":[{"id":"a"},{"id":"b"}]}',
          contentType: "application/json",
        }),
        "items.1.id"
      )
    ).toBe("b");
    expect(extractJsonField(makeRequest({ body: '{"items":[]}' }), "items.0.id")).toBeUndefined();
  });
});

describe("isStripeWebhook", () => {
  it("detects stripe-signature header", () => {
    expect(isStripeWebhook(makeRequest({ headers: { "stripe-signature": "t=1234" } }))).toBe(true);
  });

  it("detects case-insensitive", () => {
    expect(isStripeWebhook(makeRequest({ headers: { "Stripe-Signature": "t=1234" } }))).toBe(true);
  });

  it("returns false without header", () => {
    expect(isStripeWebhook(makeRequest())).toBe(false);
  });
});

describe("isGitHubWebhook", () => {
  it("detects x-github-event header", () => {
    expect(isGitHubWebhook(makeRequest({ headers: { "x-github-event": "push" } }))).toBe(true);
  });

  it("returns false without header", () => {
    expect(isGitHubWebhook(makeRequest())).toBe(false);
  });
});

describe("isShopifyWebhook", () => {
  it("detects x-shopify-hmac-sha256 header", () => {
    expect(isShopifyWebhook(makeRequest({ headers: { "x-shopify-hmac-sha256": "abc" } }))).toBe(
      true
    );
  });

  it("is case-insensitive", () => {
    expect(isShopifyWebhook(makeRequest({ headers: { "X-Shopify-Hmac-Sha256": "abc" } }))).toBe(
      true
    );
  });

  it("returns false without header", () => {
    expect(isShopifyWebhook(makeRequest())).toBe(false);
  });
});

describe("isSlackWebhook", () => {
  it("detects x-slack-signature header", () => {
    expect(isSlackWebhook(makeRequest({ headers: { "x-slack-signature": "v0=abc" } }))).toBe(true);
  });

  it("returns false without header", () => {
    expect(isSlackWebhook(makeRequest())).toBe(false);
  });
});

describe("isTwilioWebhook", () => {
  it("detects x-twilio-signature header", () => {
    expect(isTwilioWebhook(makeRequest({ headers: { "x-twilio-signature": "abc" } }))).toBe(true);
  });

  it("returns false without header", () => {
    expect(isTwilioWebhook(makeRequest())).toBe(false);
  });
});

describe("isPaddleWebhook", () => {
  it("detects paddle-signature header", () => {
    expect(isPaddleWebhook(makeRequest({ headers: { "paddle-signature": "ts=123" } }))).toBe(true);
  });

  it("returns false without header", () => {
    expect(isPaddleWebhook(makeRequest())).toBe(false);
  });
});

describe("isLinearWebhook", () => {
  it("detects linear-signature header", () => {
    expect(isLinearWebhook(makeRequest({ headers: { "linear-signature": "sha256=abc" } }))).toBe(
      true
    );
  });

  it("returns false without header", () => {
    expect(isLinearWebhook(makeRequest())).toBe(false);
  });
});

describe("isDiscordWebhook", () => {
  it("detects both Discord signature headers", () => {
    expect(
      isDiscordWebhook(
        makeRequest({
          headers: {
            "x-signature-ed25519": "deadbeef",
            "x-signature-timestamp": "1700000000",
          },
        })
      )
    ).toBe(true);
  });

  it("returns false when either Discord header is missing", () => {
    expect(
      isDiscordWebhook(
        makeRequest({
          headers: {
            "x-signature-ed25519": "deadbeef",
          },
        })
      )
    ).toBe(false);
  });
});

describe("isStandardWebhook", () => {
  it("detects all three Standard Webhooks headers", () => {
    expect(
      isStandardWebhook(
        makeRequest({
          headers: {
            "webhook-id": "msg_123",
            "webhook-timestamp": "1700000000",
            "webhook-signature": "v1,abc123",
          },
        })
      )
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isStandardWebhook(
        makeRequest({
          headers: {
            "Webhook-Id": "msg_123",
            "Webhook-Timestamp": "1700000000",
            "Webhook-Signature": "v1,abc123",
          },
        })
      )
    ).toBe(true);
  });

  it("returns false when only some headers present", () => {
    expect(
      isStandardWebhook(
        makeRequest({
          headers: {
            "webhook-id": "msg_123",
            "webhook-timestamp": "1700000000",
          },
        })
      )
    ).toBe(false);
  });

  it("returns false without headers", () => {
    expect(isStandardWebhook(makeRequest())).toBe(false);
  });
});
