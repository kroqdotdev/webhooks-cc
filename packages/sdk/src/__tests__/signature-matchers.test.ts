import { describe, it, expect } from "vitest";
import { matchVerified, matchUnverified, matchAll, matchMethod } from "../matchers";
import type { Request } from "../types";

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: "r1",
    endpointId: "ep1",
    method: "POST",
    path: "/webhook",
    headers: {},
    queryParams: {},
    ip: "127.0.0.1",
    size: 42,
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe("matchVerified", () => {
  it("matches when signatureVerified is true", () => {
    const matcher = matchVerified();
    expect(matcher(makeRequest({ signatureVerified: true }))).toBe(true);
  });

  it("rejects when signatureVerified is false", () => {
    const matcher = matchVerified();
    expect(matcher(makeRequest({ signatureVerified: false }))).toBe(false);
  });

  it("rejects when signatureVerified is null", () => {
    const matcher = matchVerified();
    expect(matcher(makeRequest({ signatureVerified: null }))).toBe(false);
  });

  it("rejects when signatureVerified is undefined", () => {
    const matcher = matchVerified();
    expect(matcher(makeRequest({ signatureVerified: undefined }))).toBe(false);
  });

  it("rejects when signatureVerified is not set", () => {
    const matcher = matchVerified();
    expect(matcher(makeRequest())).toBe(false);
  });
});

describe("matchUnverified", () => {
  it("matches when signatureVerified is false", () => {
    const matcher = matchUnverified();
    expect(matcher(makeRequest({ signatureVerified: false }))).toBe(true);
  });

  it("rejects when signatureVerified is true", () => {
    const matcher = matchUnverified();
    expect(matcher(makeRequest({ signatureVerified: true }))).toBe(false);
  });

  it("rejects when signatureVerified is null (not configured)", () => {
    const matcher = matchUnverified();
    expect(matcher(makeRequest({ signatureVerified: null }))).toBe(false);
  });

  it("rejects when signatureVerified is undefined", () => {
    const matcher = matchUnverified();
    expect(matcher(makeRequest({ signatureVerified: undefined }))).toBe(false);
  });
});

describe("matchVerified with composition", () => {
  it("combines with matchMethod via matchAll", () => {
    const matcher = matchAll(matchMethod("POST"), matchVerified());
    expect(
      matcher(makeRequest({ method: "POST", signatureVerified: true }))
    ).toBe(true);
    expect(
      matcher(makeRequest({ method: "GET", signatureVerified: true }))
    ).toBe(false);
    expect(
      matcher(makeRequest({ method: "POST", signatureVerified: false }))
    ).toBe(false);
  });
});

describe("verification fields on Request type", () => {
  it("signatureVerified field is accessible", () => {
    const req = makeRequest({ signatureVerified: true });
    expect(req.signatureVerified).toBe(true);
  });

  it("signatureError field is accessible", () => {
    const req = makeRequest({
      signatureVerified: false,
      signatureError: '{"code":"mismatch"}',
    });
    expect(req.signatureError).toBe('{"code":"mismatch"}');
  });

  it("signingProvider field is accessible", () => {
    const req = makeRequest({ signingProvider: "stripe" });
    expect(req.signingProvider).toBe("stripe");
  });
});
