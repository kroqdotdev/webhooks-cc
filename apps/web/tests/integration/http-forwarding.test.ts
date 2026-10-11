import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser, updateEndpointBySlugForUser } from "@/lib/supabase/endpoints";
import {
  getDeliverySummary,
  getForwardSecret,
  listRecentDeliveries,
  queueFailedRedeliveries,
} from "@/lib/supabase/forwarding";
import { runForwardingBatch } from "@/lib/forwarding/worker";

/**
 * Forwarding of HTTP requests (migration 00058) against the local database
 * and a local HTTP server standing in for the destination. Needs
 * FORWARDING_ALLOW_PRIVATE_TARGETS (as in .env.local) so deliveries may go to
 * 127.0.0.1. Captures go through capture_webhook() as the receiver calls it.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let userId: string;
const endpoints: { id: string; slug: string }[] = [];
let server: Server;
let base: string;
const received: { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-http-forwarding-${Date.now()}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  userId = data.user!.id;

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      if (req.url?.startsWith("/down")) res.writeHead(503).end("busy");
      else if (req.url?.startsWith("/slow")) setTimeout(() => res.writeHead(200).end("ok"), 300);
      else res.writeHead(200).end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  server?.close();
  for (const endpoint of endpoints) {
    await admin.from("endpoints").update({ forward_enabled: false }).eq("id", endpoint.id);
    await admin.from("requests").delete().eq("endpoint_id", endpoint.id);
    await admin.from("endpoints").update({ request_count: 0 }).eq("id", endpoint.id);
    await admin.from("endpoints").delete().eq("id", endpoint.id);
  }
  if (userId) await admin.auth.admin.deleteUser(userId);
});

async function forwardingEndpoint(
  path: string,
  settings: Parameters<typeof updateEndpointBySlugForUser>[0] extends infer T
    ? Omit<Partial<T>, "userId" | "slug">
    : never = {}
) {
  const endpoint = await createEndpointForUser({ userId, name: "HTTP forwarding" });
  endpoints.push({ id: endpoint.id, slug: endpoint.slug });
  await updateEndpointBySlugForUser({
    userId,
    slug: endpoint.slug,
    forwardUrl: `${base}${path}`,
    forwardEnabled: true,
    forwardHttp: true,
    forwardEmail: false,
    ...settings,
  });
  return endpoint;
}

async function capture(
  slug: string,
  options: { method?: string; path?: string; body?: Buffer; query?: string; headers?: object } = {}
) {
  const body = options.body ?? Buffer.from('{"id":"evt_1"}');
  const utf8 = body.toString("utf8");
  const exact = Buffer.from(utf8, "utf8").equals(body) && !body.includes(0);
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
    p_method: options.method ?? "POST",
    p_path: options.path ?? "/",
    p_headers: options.headers ?? { "content-type": "application/json" },
    p_body: exact ? utf8 : utf8.replaceAll("\u0000", "\ufffd"),
    p_query_params: {},
    p_content_type: "application/json",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
    p_body_raw: exact ? null : `\\x${body.toString("hex")}`,
    p_query_raw: options.query ?? null,
  });
  if (error) throw error;
  return (data as { request_id: string }).request_id;
}

async function deliveries(endpointId: string) {
  const { data, error } = await admin
    .from("email_deliveries")
    .select("id, request_id, kind, status, attempts, next_attempt_at, last_status, last_error")
    .eq("endpoint_id", endpointId)
    .order("created_at");
  if (error) throw error;
  return data;
}

/** Runs the worker until every delivery of the endpoint was tried at least once. */
async function drain(endpointId: string, rounds = 40) {
  for (let i = 0; i < rounds; i++) {
    await runForwardingBatch();
    const rows = await deliveries(endpointId);
    if (rows.length > 0 && rows.every((row) => row.attempts > 0 && row.status !== "pending")) {
      return rows;
    }
    if (rows.length > 0 && rows.every((row) => row.attempts > 0)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("deliveries were not tried");
}

describe("forwarding HTTP requests", () => {
  it("relays method, path, query, headers and exact bytes, with signed metadata", async () => {
    const endpoint = await forwardingEndpoint("/in", {
      forwardHeaders: [{ name: "X-Api-Key", value: "k-123" }],
    });
    const bytes = Buffer.from([0x7b, 0x00, 0xff, 0x7d]);
    const requestId = await capture(endpoint.slug, {
      method: "PUT",
      path: "/stripe/events",
      body: bytes,
      query: "b=2&a=1&a=3",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=abc" },
    });

    const [delivery] = await drain(endpoint.id);
    expect(delivery).toMatchObject({ kind: "http", status: "succeeded", last_status: 200 });
    const got = received.find((r) => r.headers["webhooks-cc-request-id"] === requestId)!;
    expect(got.method).toBe("PUT");
    expect(got.url).toBe("/in/stripe/events?b=2&a=1&a=3");
    expect(got.body.equals(bytes)).toBe(true);
    expect(got.headers["stripe-signature"]).toBe("t=1,v1=abc");
    expect(got.headers["x-api-key"]).toBe("k-123");
    expect(got.headers["webhooks-cc-endpoint"]).toBe(endpoint.slug);
    expect(got.headers["webhooks-cc-attempt"]).toBe("1");

    const secret = (await getForwardSecret(userId, endpoint.slug))!;
    const receivedAt = got.headers["webhooks-cc-received-at"] as string;
    expect(receivedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const mac = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
      .update(`${requestId}.${receivedAt}.`)
      .update(bytes)
      .digest("base64");
    expect(got.headers["webhooks-cc-signature"]).toBe(`v1,${mac}`);

    const [recent] = await listRecentDeliveries(endpoint.id, { limit: 5 });
    expect(recent).toMatchObject({
      kind: "http",
      method: "PUT",
      path: "/stripe/events",
      format: "as_received",
    });
    expect(recent.receivedAt).not.toBeNull();
    expect(recent.finishedAt).not.toBeNull();
    expect(recent.lastDurationMs).not.toBeNull();
  });

  it("keeps the URL as written when appending the path is off", async () => {
    const endpoint = await forwardingEndpoint("/fixed", { forwardAppendPath: false });
    const requestId = await capture(endpoint.slug, { path: "/ignored/path", query: "x=1" });
    await drain(endpoint.id);
    const got = received.find((r) => r.headers["webhooks-cc-request-id"] === requestId)!;
    expect(got.url).toBe("/fixed?x=1");
  });

  it("sends a chat message when the format says so", async () => {
    const endpoint = await forwardingEndpoint("/chat", { forwardFormat: "chat" });
    const requestId = await capture(endpoint.slug, { path: "/orders" });
    await drain(endpoint.id);
    const got = received.filter((r) => r.url === "/chat").at(-1)!;
    const payload = JSON.parse(got.body.toString());
    expect(payload.text).toMatch(/^New webhook on \*[a-z0-9]+\* \(`POST \/orders`\)\nReceived /);
    expect(payload.text).toContain('{"id":"evt_1"}');
    expect(got.headers["webhooks-cc-request-id"]).toBeUndefined();
    expect(requestId).toBeTruthy();
  });

  it("stops after one try when retries are off, and retries within the window otherwise", async () => {
    const once = await forwardingEndpoint("/down", { forwardRetrySeconds: 0 });
    await capture(once.slug);
    const [failed] = await drain(once.id);
    expect(failed).toMatchObject({ status: "failed", attempts: 1, last_status: 503 });

    const retried = await forwardingEndpoint("/down", { forwardRetrySeconds: 3600 });
    await capture(retried.slug);
    const [pending] = await drain(retried.id);
    expect(pending).toMatchObject({ status: "pending", attempts: 1, last_status: 503 });
    expect(Date.parse(pending.next_attempt_at)).toBeGreaterThan(Date.now() + 20_000);
  });

  it("keeps capture order with one delivery at a time", async () => {
    const endpoint = await forwardingEndpoint("/slow", { forwardKeepOrder: true });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await capture(endpoint.slug, { path: `/n${i}` }));
    const first = await runForwardingBatch();
    expect(first).toBe(1);
    for (let i = 0; i < 20; i++) {
      const rows = await deliveries(endpoint.id);
      if (rows.every((row) => row.status === "succeeded")) break;
      await runForwardingBatch();
    }
    const order = received
      .filter((r) => r.url.startsWith("/slow"))
      .map((r) => r.headers["webhooks-cc-request-id"]);
    expect(order).toEqual(ids);
  });

  it("does not forward HTTP requests while only email is on, and settles them when HTTP turns off", async () => {
    const endpoint = await forwardingEndpoint("/off", { forwardHttp: false, forwardEmail: true });
    await capture(endpoint.slug);
    expect(await deliveries(endpoint.id)).toEqual([]);

    await updateEndpointBySlugForUser({ userId, slug: endpoint.slug, forwardHttp: true });
    await capture(endpoint.slug);
    await updateEndpointBySlugForUser({ userId, slug: endpoint.slug, forwardHttp: false });
    const [settled] = await deliveries(endpoint.id);
    expect(settled).toMatchObject({
      status: "failed",
      last_error: "Forwarding of HTTP requests was turned off.",
    });
  });

  it("records a capture as not sent past the pending cap", async () => {
    const endpoint = await forwardingEndpoint("/in");
    const first = await capture(endpoint.slug);
    const { data, error } = await admin.rpc("queue_capture_delivery", {
      p_request_id: first,
      p_endpoint_id: endpoint.id,
      p_kind: "http",
      p_max_pending: 1,
    });
    expect(error).toBeNull();
    const { data: row } = await admin
      .from("email_deliveries")
      .select("status, last_error")
      .eq("id", data as string)
      .single();
    expect(row).toMatchObject({
      status: "failed",
      last_error: "Not sent: 1 deliveries were already waiting for this URL.",
    });
  });

  it("keeps the owner's header values when the list is saved without them", async () => {
    const endpoint = await forwardingEndpoint("/in", {
      forwardHeaders: [
        { name: "Authorization", value: "Bearer secret-1" },
        { name: "X-Team", value: "ops" },
      ],
    });
    const updated = await updateEndpointBySlugForUser({
      userId,
      slug: endpoint.slug,
      forwardHeaders: [{ name: "Authorization", value: null }],
    });
    expect(updated?.forwardHeaders).toEqual([{ name: "Authorization", value: "Bearer ••••" }]);
    const requestId = await capture(endpoint.slug);
    await drain(endpoint.id);
    const got = received.find((r) => r.headers["webhooks-cc-request-id"] === requestId)!;
    expect(got.headers.authorization).toBe("Bearer secret-1");
    expect(got.headers["x-team"]).toBeUndefined();
  });

  it("records the format, the target and the sender's own time from the named field", async () => {
    const endpoint = await forwardingEndpoint("/hooks?token=secret", {
      forwardSentField: "meta.publishedAt",
    });
    const publishedAt = new Date(Date.now() - 250).toISOString();
    await capture(endpoint.slug, {
      path: "/orders",
      body: Buffer.from(JSON.stringify({ meta: { publishedAt: publishedAt } })),
    });
    await drain(endpoint.id);
    const { data: row } = await admin
      .from("email_deliveries")
      .select("format, target, sender_at, sender_source")
      .eq("endpoint_id", endpoint.id)
      .single();
    expect(row).toMatchObject({
      format: "as_received",
      target: `${new URL(base).host}/hooks/orders`,
      sender_source: "meta.publishedAt",
    });
    expect(Date.parse(row!.sender_at!)).toBe(Date.parse(publishedAt));

    const [listed] = await listRecentDeliveries(endpoint.id, { limit: 1 });
    expect(listed).toMatchObject({ senderAt: Date.parse(publishedAt), format: "as_received" });
  });

  it("redelivers every failed request in capture order, and counts and pages the log", async () => {
    const endpoint = await forwardingEndpoint("/down", { forwardRetrySeconds: 0 });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await capture(endpoint.slug, { path: `/r${i}` }));
    await drain(endpoint.id);

    const summary = await getDeliverySummary(endpoint.id);
    expect(summary).toMatchObject({
      last24h: { delivered: 0, failed: 3 },
      pending: 0,
      failed: 3,
      total: 3,
    });
    const page = await listRecentDeliveries(endpoint.id, { limit: 2, status: "failed" });
    expect(page.map((row) => row.requestId)).toEqual([ids[2], ids[1]]);
    const older = await listRecentDeliveries(endpoint.id, {
      limit: 2,
      status: "failed",
      before: page[1].cursor,
    });
    expect(older.map((row) => row.requestId)).toEqual([ids[0]]);

    await updateEndpointBySlugForUser({
      userId,
      slug: endpoint.slug,
      forwardUrl: `${base}/again`,
      forwardKeepOrder: true,
    });
    expect(await queueFailedRedeliveries(endpoint.id)).toBe(3);
    // Nothing failed is left whose latest delivery failed, so a second press queues nothing.
    expect(await queueFailedRedeliveries(endpoint.id)).toBe(0);
    expect((await getDeliverySummary(endpoint.id)).pending).toBe(3);

    for (let i = 0; i < 30; i++) {
      const rows = await deliveries(endpoint.id);
      if (rows.filter((row) => row.status === "succeeded").length === 3) break;
      await runForwardingBatch();
    }
    const order = received
      .filter((r) => r.url.startsWith("/again"))
      .map((r) => r.headers["webhooks-cc-request-id"]);
    expect(order).toEqual(ids);
    expect(await listRecentDeliveries(endpoint.id, { status: "pending" })).toEqual([]);
  });

  it("queues nothing again while forwarding is off", async () => {
    const endpoint = await forwardingEndpoint("/down", { forwardRetrySeconds: 0 });
    await capture(endpoint.slug);
    await drain(endpoint.id);
    await updateEndpointBySlugForUser({ userId, slug: endpoint.slug, forwardEnabled: false });
    expect(await queueFailedRedeliveries(endpoint.id)).toBe(0);
  });
});
