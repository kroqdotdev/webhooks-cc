import { describe, expect, it } from "vitest";
import type { RequestRecord } from "@/lib/supabase/requests";
import {
  deliveryTarget,
  holdChat,
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
