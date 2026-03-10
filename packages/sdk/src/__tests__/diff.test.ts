import { describe, expect, it } from "vitest";
import { diffRequests } from "../diff";
import type { Request } from "../types";

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: "r1",
    endpointId: "ep1",
    method: "POST",
    path: "/webhooks/stripe",
    headers: { "content-type": "application/json" },
    queryParams: {},
    ip: "127.0.0.1",
    size: 0,
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe("diffRequests", () => {
  it("returns matches=true when requests are equivalent", () => {
    const left = makeRequest({
      headers: { "Content-Type": "application/json", "X-Request-Id": "req_1" },
      body: JSON.stringify({ ok: true }),
    });
    const right = makeRequest({
      headers: { "content-type": "application/json", "x-request-id": "req_1" },
      body: JSON.stringify({ ok: true }),
    });

    expect(diffRequests(left, right)).toEqual({
      matches: true,
      differences: {},
    });
  });

  it("diffs method, path, and headers while ignoring configured headers case-insensitively", () => {
    const left = makeRequest({
      method: "POST",
      path: "/webhooks/stripe",
      headers: {
        "Content-Type": "application/json",
        Date: "Mon, 09 Mar 2026 12:00:00 GMT",
        "X-Old": "left-only",
        "Stripe-Signature": "sig_left",
      },
    });
    const right = makeRequest({
      method: "PUT",
      path: "/webhooks/github",
      headers: {
        "content-type": "application/json; charset=utf-8",
        date: "Mon, 09 Mar 2026 12:00:01 GMT",
        "X-New": "right-only",
        "stripe-signature": "sig_right",
      },
    });

    const diff = diffRequests(left, right, { ignoreHeaders: ["date"] });

    expect(diff.matches).toBe(false);
    expect(diff.differences.method).toEqual({ left: "POST", right: "PUT" });
    expect(diff.differences.path).toEqual({
      left: "/webhooks/stripe",
      right: "/webhooks/github",
    });
    expect(diff.differences.headers).toEqual({
      added: ["x-new"],
      removed: ["x-old"],
      changed: {
        "content-type": {
          left: "application/json",
          right: "application/json; charset=utf-8",
        },
        "stripe-signature": {
          left: "sig_left",
          right: "sig_right",
        },
      },
    });
  });

  it("produces structured JSON body diffs with dotted paths", () => {
    const left = makeRequest({
      body: JSON.stringify({
        type: "payment_intent.succeeded",
        data: { object: { amount: 2000, metadata: { region: "us" } } },
        items: [{ id: "a1", qty: 1 }],
      }),
    });
    const right = makeRequest({
      body: JSON.stringify({
        type: "payment_intent.succeeded",
        data: { object: { amount: 3000, metadata: { region: "eu" } } },
        items: [
          { id: "a1", qty: 2 },
          { id: "a2", qty: 1 },
        ],
      }),
    });

    const diff = diffRequests(left, right);

    expect(diff.matches).toBe(false);
    expect(diff.differences.body).toEqual({
      type: "json",
      changed: {
        "data.object.amount": { left: 2000, right: 3000 },
        "data.object.metadata.region": { left: "us", right: "eu" },
        "items.0.qty": { left: 1, right: 2 },
        "items.1": { left: undefined, right: { id: "a2", qty: 1 } },
      },
      diff: [
        "data.object.amount: 2000 -> 3000",
        'data.object.metadata.region: "us" -> "eu"',
        "items.0.qty: 1 -> 2",
        'items.1: undefined -> {"id":"a2","qty":1}',
      ].join("\n"),
    });
  });

  it("falls back to text diffs when bodies are not both valid JSON", () => {
    const left = makeRequest({ body: "hello\nworld" });
    const right = makeRequest({ body: "hello\nmars" });

    expect(diffRequests(left, right).differences.body).toEqual({
      type: "text",
      diff: "- world\n+ mars",
    });
  });

  it("treats undefined and empty-string bodies as equivalent", () => {
    const left = makeRequest({ body: undefined });
    const right = makeRequest({ body: "" });

    expect(diffRequests(left, right)).toEqual({
      matches: true,
      differences: {},
    });
  });
});
