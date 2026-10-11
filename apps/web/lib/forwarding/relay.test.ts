import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestRecord } from "@/lib/supabase/requests";
import { resolveFormat } from "./format";
import { checkOwnerHeaders, maskOwnerHeaders, refusedHeaderName } from "./owner-headers";
import { buildRelay, destinationUrl, relaySignature, RELAY_HEADER } from "./relay";
import { isDelivered, sendForward } from "./send";

const SECRET = `whsec_${Buffer.alloc(24, 7).toString("base64")}`;

function captured(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: "6b3f2c1e-0000-4000-8000-000000000001",
    endpointId: "e1",
    method: "POST",
    path: "/stripe/events",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=1,v1=abc",
      "user-agent": "Stripe/1.0",
      host: "go.webhooks.cc",
      "content-length": "12",
      connection: "keep-alive",
    },
    body: '{"id":"evt"}',
    queryParams: { b: "2", a: "1" },
    queryRaw: "b=2&a=1&a=3",
    ip: "203.0.113.9",
    size: 12,
    receivedAt: Date.parse("2026-10-10T15:25:09.231Z"),
    kind: "http",
    ...overrides,
  };
}

describe("destinationUrl", () => {
  it("appends the captured path and query", () => {
    expect(destinationUrl("https://dest.example/hooks", "/stripe/events", "a=1", true)).toBe(
      "https://dest.example/hooks/stripe/events?a=1"
    );
    expect(destinationUrl("https://dest.example/hooks/", "/x", null, true)).toBe(
      "https://dest.example/hooks/x"
    );
    expect(destinationUrl("https://dest.example/hooks?token=t", "/x", "b=2&a=1", true)).toBe(
      "https://dest.example/hooks/x?token=t&b=2&a=1"
    );
  });

  it("keeps the URL as written when appending is off or the path is the root", () => {
    expect(destinationUrl("https://dest.example/hooks", "/x", "a=1", false)).toBe(
      "https://dest.example/hooks?a=1"
    );
    expect(destinationUrl("https://dest.example/hooks", "/", null, true)).toBe(
      "https://dest.example/hooks"
    );
  });

  it("never leaves the forwarding URL's path", () => {
    expect(destinationUrl("https://dest.example/hooks", "/../../admin", null, true)).toBe(
      "https://dest.example/hooks/admin"
    );
    expect(destinationUrl("https://dest.example/hooks", "/a/./../b/..", null, true)).toBe(
      "https://dest.example/hooks/a/b"
    );
    expect(destinationUrl("https://dest.example/hooks", "/..", null, true)).toBe(
      "https://dest.example/hooks"
    );
    // A decoded "%2e%2e" arrives as text "%2e%2e" and is sent encoded, not resolved.
    expect(destinationUrl("https://dest.example/hooks", "/%2e%2e/x", null, true)).toBe(
      "https://dest.example/hooks/%252e%252e/x"
    );
  });

  it("encodes what a path cannot hold", () => {
    expect(destinationUrl("https://dest.example", "/a b/ø?#", null, true)).toBe(
      "https://dest.example/a%20b/%C3%B8%3F%23"
    );
  });
});

describe("buildRelay", () => {
  it("relays method, headers and body, adds signed metadata and the owner's headers", () => {
    const relay = buildRelay(captured(), {
      forwardUrl: "https://dest.example/hooks",
      appendPath: true,
      slug: "demo4slug1",
      attempt: 2,
      secret: SECRET,
      ownerHeaders: [["Authorization", "Bearer s3cret"]],
    });
    expect(relay.method).toBe("POST");
    expect(relay.mode).toBe("relay");
    expect(relay.url).toBe("https://dest.example/hooks/stripe/events?b=2&a=1&a=3");
    expect(relay.body?.toString()).toBe('{"id":"evt"}');
    const headers = Object.fromEntries(relay.headers);
    expect(headers["stripe-signature"]).toBe("t=1,v1=abc");
    expect(headers["user-agent"]).toBe("Stripe/1.0");
    expect(headers).not.toHaveProperty("host");
    expect(headers).not.toHaveProperty("content-length");
    expect(headers).not.toHaveProperty("connection");
    expect(headers[RELAY_HEADER.receivedAt]).toBe("2026-10-10T15:25:09.231Z");
    expect(headers[RELAY_HEADER.requestId]).toBe(captured().id);
    expect(headers[RELAY_HEADER.endpoint]).toBe("demo4slug1");
    expect(headers[RELAY_HEADER.attempt]).toBe("2");
    expect(headers.Authorization).toBe("Bearer s3cret");
    const key = Buffer.from(SECRET.slice(6), "base64");
    const expected = createHmac("sha256", key)
      .update(`${captured().id}.2026-10-10T15:25:09.231Z.{"id":"evt"}`)
      .digest("base64");
    expect(headers[RELAY_HEADER.signature]).toBe(`v1,${expected}`);
  });

  it("uses the raw bytes for a body that is not UTF-8 and sends no body for GET", () => {
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x41]);
    const binary = buildRelay(captured({ body: "��", bodyRaw: bytes.toString("base64") }), {
      forwardUrl: "https://dest.example",
      appendPath: false,
      slug: "s",
      attempt: 1,
      secret: SECRET,
      ownerHeaders: [],
    });
    expect(binary.body?.equals(bytes)).toBe(true);
    expect(relaySignature(SECRET, captured().id, "2026-10-10T15:25:09.231Z", bytes)).toBe(
      Object.fromEntries(binary.headers)[RELAY_HEADER.signature]
    );
    const get = buildRelay(captured({ method: "GET" }), {
      forwardUrl: "https://dest.example",
      appendPath: false,
      slug: "s",
      attempt: 1,
      secret: SECRET,
      ownerHeaders: [],
    });
    expect(get.body).toBeNull();
  });

  it("an owner header replaces a captured one of the same name", () => {
    const relay = buildRelay(captured({ headers: { authorization: "Bearer from-sender" } }), {
      forwardUrl: "https://dest.example",
      appendPath: false,
      slug: "s",
      attempt: 1,
      secret: SECRET,
      ownerHeaders: [["Authorization", "Bearer from-owner"]],
    });
    const auth = relay.headers.filter(([name]) => name.toLowerCase() === "authorization");
    expect(auth).toEqual([["Authorization", "Bearer from-owner"]]);
  });
});

describe("owner headers", () => {
  it("refuses reserved and malformed names", () => {
    expect(refusedHeaderName("Authorization")).toBeNull();
    expect(refusedHeaderName("X-Api-Key")).toBeNull();
    expect(refusedHeaderName("Host")).toMatch(/cannot be added/);
    expect(refusedHeaderName("webhook-signature")).toMatch(/Standard Webhooks/);
    expect(refusedHeaderName("Webhooks-CC-Received-At")).toMatch(/reserved/);
    expect(refusedHeaderName("bad name")).toMatch(/not a valid header name/);
    expect(refusedHeaderName("X-Target-URL")).toMatch(/reserved by webhooks.cc/);
    expect(refusedHeaderName("x-auth")).toMatch(/reserved by webhooks.cc/);
  });

  it("checks a submitted set", () => {
    expect(checkOwnerHeaders([{ name: "Authorization", value: "Bearer x" }])).toEqual({
      ok: true,
      headers: [["Authorization", "Bearer x"]],
    });
    expect(checkOwnerHeaders([{ name: "A", value: "1\r\nB: 2" }])).toMatchObject({ ok: false });
    expect(
      checkOwnerHeaders([
        { name: "A", value: "1" },
        { name: "a", value: "2" },
      ])
    ).toMatchObject({ ok: false, error: "a is listed twice." });
    expect(
      checkOwnerHeaders(Array.from({ length: 11 }, (_, i) => ({ name: `H${i}`, value: "v" })))
    ).toMatchObject({ ok: false });
  });

  it("masks values", () => {
    expect(
      maskOwnerHeaders([
        ["Authorization", "Bearer abcdefgh1234"],
        ["X-Short", "abc"],
        ["X-Api-Key", "sk_live_abcdefgh5678"],
        ["X-Pair", "s3cretKey v2-abcdefgh"],
      ])
    ).toEqual([
      { name: "Authorization", value: "Bearer ••••1234" },
      { name: "X-Short", value: "••••" },
      { name: "X-Api-Key", value: "••••5678" },
      { name: "X-Pair", value: "••••efgh" },
    ]);
  });
});

describe("resolveFormat", () => {
  it("picks chat for Slack and Discord unless overridden", () => {
    const slack = "https://hooks.slack.com/services/T/B/x";
    expect(resolveFormat("http", null, slack)).toBe("chat");
    expect(resolveFormat("email", null, "https://discord.com/api/webhooks/1/a")).toBe("chat");
    expect(resolveFormat("http", null, "https://dest.example")).toBe("as_received");
    expect(resolveFormat("email", null, "https://dest.example")).toBe("json");
    expect(resolveFormat("http", "as_received", slack)).toBe("as_received");
    expect(resolveFormat("email", "as_received", slack)).toBe("json");
    expect(resolveFormat("http", "chat", "https://dest.example")).toBe("chat");
    expect(resolveFormat("http", "json", "https://dest.example")).toBe("json");
    expect(resolveFormat("email", "json", slack)).toBe("json");
  });
});

describe("relay, direct", () => {
  let server: Server;
  let base: string;
  const seen: {
    method?: string;
    url?: string;
    headers?: IncomingMessage["headers"];
    body?: Buffer;
  }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks),
        });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("arrives with the method, path, query, headers and exact bytes", async () => {
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0x7b]);
    const relay = buildRelay(
      captured({ method: "PUT", bodyRaw: bytes.toString("base64"), body: "x" }),
      {
        forwardUrl: `${base}/in`,
        appendPath: true,
        slug: "demo4slug1",
        attempt: 1,
        secret: SECRET,
        ownerHeaders: [["X-Api-Key", "k"]],
      }
    );
    const result = await sendForward(relay, { timeoutMs: 2000, proxy: null, allowPrivate: true });
    expect(isDelivered(result)).toBe(true);
    const got = seen.at(-1)!;
    expect(got.method).toBe("PUT");
    expect(got.url).toBe("/in/stripe/events?b=2&a=1&a=3");
    expect(got.body?.equals(bytes)).toBe(true);
    expect(got.headers?.["stripe-signature"]).toBe("t=1,v1=abc");
    expect(got.headers?.["x-api-key"]).toBe("k");
    expect(got.headers?.[RELAY_HEADER.receivedAt]).toBe("2026-10-10T15:25:09.231Z");
    expect(got.headers?.host).toMatch(/^127\.0\.0\.1:/);
  });
});
