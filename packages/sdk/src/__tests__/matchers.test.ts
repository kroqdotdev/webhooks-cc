import { describe, it, expect } from "vitest";
import {
  matchMethod,
  matchHeader,
  matchBodyPath,
  matchAll,
  matchAny,
  matchJsonField,
} from "../matchers";
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

describe("matchMethod", () => {
  it("matches exact method", () => {
    const matcher = matchMethod("POST");
    expect(matcher(makeRequest({ method: "POST" }))).toBe(true);
  });

  it("is case-insensitive", () => {
    const matcher = matchMethod("post");
    expect(matcher(makeRequest({ method: "POST" }))).toBe(true);
  });

  it("rejects non-matching method", () => {
    const matcher = matchMethod("GET");
    expect(matcher(makeRequest({ method: "POST" }))).toBe(false);
  });
});

describe("matchHeader", () => {
  it("matches header presence", () => {
    const matcher = matchHeader("x-github-event");
    expect(matcher(makeRequest({ headers: { "X-GitHub-Event": "push" } }))).toBe(true);
  });

  it("matches header with specific value", () => {
    const matcher = matchHeader("x-github-event", "push");
    expect(matcher(makeRequest({ headers: { "X-GitHub-Event": "push" } }))).toBe(true);
  });

  it("rejects header with wrong value", () => {
    const matcher = matchHeader("x-github-event", "pull_request");
    expect(matcher(makeRequest({ headers: { "X-GitHub-Event": "push" } }))).toBe(false);
  });

  it("rejects missing header", () => {
    const matcher = matchHeader("x-github-event");
    expect(matcher(makeRequest({ headers: {} }))).toBe(false);
  });

  it("is case-insensitive for header name", () => {
    const matcher = matchHeader("Content-Type");
    expect(matcher(makeRequest({ headers: { "content-type": "application/json" } }))).toBe(true);
  });
});

describe("matchBodyPath", () => {
  it("matches top-level field", () => {
    const matcher = matchBodyPath("type", "checkout.session.completed");
    expect(
      matcher(makeRequest({ body: JSON.stringify({ type: "checkout.session.completed" }) }))
    ).toBe(true);
  });

  it("matches nested field", () => {
    const matcher = matchBodyPath("data.object.id", "obj_123");
    expect(
      matcher(makeRequest({ body: JSON.stringify({ data: { object: { id: "obj_123" } } }) }))
    ).toBe(true);
  });

  it("rejects wrong value", () => {
    const matcher = matchBodyPath("type", "payment_intent.succeeded");
    expect(
      matcher(makeRequest({ body: JSON.stringify({ type: "checkout.session.completed" }) }))
    ).toBe(false);
  });

  it("rejects missing path", () => {
    const matcher = matchBodyPath("data.missing.field", "value");
    expect(matcher(makeRequest({ body: JSON.stringify({ data: {} }) }))).toBe(false);
  });

  it("handles non-JSON body", () => {
    const matcher = matchBodyPath("type", "test");
    expect(matcher(makeRequest({ body: "not json" }))).toBe(false);
  });

  it("handles undefined body", () => {
    const matcher = matchBodyPath("type", "test");
    expect(matcher(makeRequest({ body: undefined }))).toBe(false);
  });
});

describe("matchAll", () => {
  it("requires all matchers to pass", () => {
    const matcher = matchAll(matchMethod("POST"), matchHeader("content-type", "application/json"));
    expect(
      matcher(
        makeRequest({
          method: "POST",
          headers: { "content-type": "application/json" },
        })
      )
    ).toBe(true);
  });

  it("fails if any matcher fails", () => {
    const matcher = matchAll(matchMethod("POST"), matchHeader("x-custom"));
    expect(matcher(makeRequest({ method: "POST", headers: {} }))).toBe(false);
  });
});

describe("matchAny", () => {
  it("passes if any matcher passes", () => {
    const matcher = matchAny(matchMethod("GET"), matchMethod("POST"));
    expect(matcher(makeRequest({ method: "POST" }))).toBe(true);
  });

  it("fails if no matchers pass", () => {
    const matcher = matchAny(matchMethod("GET"), matchMethod("PUT"));
    expect(matcher(makeRequest({ method: "POST" }))).toBe(false);
  });
});

describe("matchJsonField (re-export)", () => {
  it("matches top-level JSON field", () => {
    const matcher = matchJsonField("action", "created");
    expect(matcher(makeRequest({ body: JSON.stringify({ action: "created" }) }))).toBe(true);
  });
});
