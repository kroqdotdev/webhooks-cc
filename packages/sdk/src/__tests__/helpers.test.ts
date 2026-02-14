import { describe, it, expect } from "vitest";
import {
  parseJsonBody,
  isStripeWebhook,
  isGitHubWebhook,
  isShopifyWebhook,
  isSlackWebhook,
  isTwilioWebhook,
  isPaddleWebhook,
  isLinearWebhook,
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
