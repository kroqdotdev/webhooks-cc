import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyStandardWebhookSignature } from "@webhooks-cc/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser, updateEndpointBySlugForUser } from "@/lib/supabase/endpoints";
import {
  createDestination,
  deleteDestination,
  getDestinationSecret,
  listDestinations,
  updateDestination,
} from "@/lib/supabase/destinations";
import { queueDestinationRedelivery } from "@/lib/supabase/forwarding";
import { runForwardingBatch } from "@/lib/forwarding/worker";

/**
 * Destinations (migration 00063) against the local database and a local
 * server standing in for the user's: several per endpoint, each with its own
 * kinds, filter, format and timing. Needs FORWARDING_ALLOW_PRIVATE_TARGETS
 * (as in .env.local). A running dev server drains the same queue with its own
 * worker; the assertions hold whichever process sends.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let userId: string;
const endpointIds: string[] = [];
let server: Server;
let base: string;
const received: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-destinations-${Date.now()}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  userId = data.user!.id;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ url: req.url ?? "", headers: req.headers, body });
      // A hook whose Zap or scenario was removed answers 410.
      if (req.url?.startsWith("/gone")) res.writeHead(410).end("gone");
      else res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  server?.close();
  for (const id of endpointIds) {
    await admin.from("endpoint_destinations").update({ enabled: false }).eq("endpoint_id", id);
    await admin.from("requests").delete().eq("endpoint_id", id);
    await admin.from("endpoints").update({ request_count: 0 }).eq("id", id);
    await admin.from("endpoints").delete().eq("id", id);
  }
  if (userId) await admin.auth.admin.deleteUser(userId);
});

async function endpoint() {
  const created = await createEndpointForUser({ userId, name: "Destinations" });
  endpointIds.push(created.id);
  return created;
}

async function capture(slug: string, body: unknown) {
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
    p_method: "POST",
    p_path: "/events",
    p_headers: { "content-type": "application/json" },
    p_body: JSON.stringify(body),
    p_query_params: {},
    p_content_type: "application/json",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
    p_body_raw: null,
  });
  if (error) throw error;
  return (data as { request_id: string }).request_id;
}

async function deliveries(endpointId: string) {
  const { data, error } = await admin
    .from("email_deliveries")
    .select(
      "id, request_id, destination_id, status, attempts, last_error, next_attempt_at, bypass_filter"
    )
    .eq("endpoint_id", endpointId)
    .order("created_at");
  if (error) throw error;
  return data;
}

/** Runs the worker until no delivery of the endpoint is due and untried. */
async function drain(endpointId: string) {
  for (let i = 0; i < 60; i++) {
    await runForwardingBatch();
    const rows = await deliveries(endpointId);
    const now = new Date().toISOString();
    if (rows.every((row) => row.status !== "pending" || row.next_attempt_at > now)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("deliveries were not settled");
}

const at = (path: string) => received.filter((r) => r.url.startsWith(path));

describe("destinations", () => {
  it("queues one delivery per destination that takes the kind", async () => {
    const e = await endpoint();
    const a = await createDestination(e.id, { url: `${base}/fan-a` });
    const b = await createDestination(e.id, { url: `${base}/fan-b`, http: false, email: true });
    const c = await createDestination(e.id, { url: `${base}/fan-c`, enabled: false });
    await capture(e.slug, { type: "x" });
    const rows = await deliveries(e.id);
    expect(rows.map((row) => row.destination_id)).toEqual([a.id]);
    expect([b.id, c.id]).not.toContain(rows[0].destination_id);
  });

  it("turns a destination off when its URL answers 410, without retrying", async () => {
    const e = await endpoint();
    const gone = await createDestination(e.id, { url: `${base}/gone` });
    await capture(e.slug, { type: "x" });
    const rows = await drain(e.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(rows[0].last_error).toContain("410");
    const { data: destination } = await admin
      .from("endpoint_destinations")
      .select("enabled")
      .eq("id", gone.id)
      .single();
    expect(destination?.enabled).toBe(false);
    // Nothing more is queued for it.
    await capture(e.slug, { type: "y" });
    expect(await deliveries(e.id)).toHaveLength(1);
  });

  it("skips what the filter turns down, and logs it", async () => {
    const e = await endpoint();
    await createDestination(e.id, {
      url: `${base}/paid`,
      filter: {
        logic: "and",
        conditions: [{ field: "body_path", op: "eq", path: "type", value: "invoice.paid" }],
      },
    });
    const paid = await capture(e.slug, { type: "invoice.paid" });
    const failed = await capture(e.slug, { type: "invoice.payment_failed" });
    const rows = await drain(e.id);
    const byRequest = new Map(rows.map((row) => [row.request_id, row]));
    expect(byRequest.get(paid)).toMatchObject({ status: "succeeded" });
    expect(byRequest.get(failed)).toMatchObject({
      status: "skipped",
      attempts: 0,
      last_error: "Not sent: the destination's filter did not match.",
    });
  });

  it("sends a JSON template, signed with the destination's own secret", async () => {
    const e = await endpoint();
    const destination = await createDestination(e.id, {
      url: `${base}/template`,
      format: "template",
      bodyTemplate: {
        event: "{{ json.type }}",
        amount: "{{ json.data.amount }}",
        missing: "{{ json.nope }}",
      },
    });
    const requestId = await capture(e.slug, { type: "order.paid", data: { amount: 4200 } });
    await drain(e.id);
    const got = at("/template").find((r) => JSON.parse(r.body).event === "order.paid")!;
    expect(JSON.parse(got.body)).toEqual({ event: "order.paid", amount: 4200, missing: null });
    const secret = await getDestinationSecret(e.id, destination.id);
    await expect(
      verifyStandardWebhookSignature(got.body, got.headers as Record<string, string>, secret!)
    ).resolves.toBe(true);
    expect(got.headers["webhook-id"]).toBe(`msg_${requestId.replaceAll("-", "")}`);
  });

  it("posts a chat message from the message template", async () => {
    const e = await endpoint();
    await createDestination(e.id, {
      url: `${base}/chat-template`,
      format: "chat",
      messageTemplate: "Paid {{ json.data.amount }} <@here>",
    });
    await capture(e.slug, { data: { amount: 99 } });
    await drain(e.id);
    const payload = JSON.parse(at("/chat-template").at(-1)!.body);
    expect(payload).toEqual({ text: "Paid 99 &lt;@here&gt;", content: "Paid 99 <@here>" });
  });

  it("queues at most one delivery per throttle window", async () => {
    const e = await endpoint();
    const destination = await createDestination(e.id, {
      url: `${base}/throttled`,
      throttleSeconds: 60,
    });
    for (let i = 0; i < 3; i++) await capture(e.slug, { n: i });
    const rows = await deliveries(e.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].destination_id).toBe(destination.id);
  });

  it("throttles a filtered destination only on what its filter lets through", async () => {
    const e = await endpoint();
    await createDestination(e.id, {
      url: `${base}/filtered-throttle`,
      throttleSeconds: 60,
      filter: {
        logic: "and",
        conditions: [{ field: "body_path", op: "eq", path: "type", value: "order" }],
      },
    });
    const ping = await capture(e.slug, { type: "ping" });
    const first = await capture(e.slug, { type: "order" });
    const second = await capture(e.slug, { type: "order" });
    const rows = await drain(e.id);
    const byRequest = new Map(rows.map((row) => [row.request_id, row]));
    expect(byRequest.get(ping)).toMatchObject({ status: "skipped" });
    expect(byRequest.get(first)).toMatchObject({ status: "succeeded" });
    expect(byRequest.get(second)).toMatchObject({
      status: "skipped",
      last_error: "Not sent: at most one every 60 s, and one went out less than that before.",
    });
  });

  it("drops a heads-up that could not go out within a minute", async () => {
    const e = await endpoint();
    await createDestination(e.id, { url: `${base}/late`, throttleSeconds: 1, retrySeconds: 0 });
    await capture(e.slug, { type: "late" });
    await admin
      .from("email_deliveries")
      .update({ created_at: new Date(Date.now() - 120_000).toISOString() })
      .eq("endpoint_id", e.id);
    const [row] = await drain(e.id);
    expect(row).toMatchObject({
      status: "skipped",
      last_error: "Not sent: a heads-up that could not go out within a minute is dropped.",
    });
  });

  it("waits the destination's delay before the first try", async () => {
    const e = await endpoint();
    await createDestination(e.id, { url: `${base}/later`, delaySeconds: 30 });
    const before = Date.now();
    await capture(e.slug, { type: "callback" });
    const [row] = await deliveries(e.id);
    expect(Date.parse(row.next_attempt_at)).toBeGreaterThan(before + 25_000);
    await runForwardingBatch();
    expect((await deliveries(e.id))[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("settles what is waiting when a destination is switched off or removed", async () => {
    const e = await endpoint();
    const parked = new Date(Date.now() + 3_600_000).toISOString();
    const off = await createDestination(e.id, { url: `${base}/off` });
    const gone = await createDestination(e.id, { url: `${base}/gone` });
    await capture(e.slug, { type: "x" });
    await admin
      .from("email_deliveries")
      .update({ next_attempt_at: parked })
      .eq("endpoint_id", e.id);
    await updateDestination(e.id, off.id, { enabled: false });
    await deleteDestination(e.id, gone.id);
    const rows = await deliveries(e.id);
    expect(rows.find((row) => row.destination_id === off.id)).toMatchObject({
      status: "failed",
      last_error: "The destination was switched off.",
    });
    // Its log row stays, without the link.
    expect(rows.find((row) => row.destination_id === null)).toMatchObject({
      status: "failed",
      last_error: "The destination was removed.",
    });
  });

  it("sends a redelivery to one destination whatever its filter says", async () => {
    const e = await endpoint();
    const destination = await createDestination(e.id, {
      url: `${base}/anyway`,
      filter: { logic: "and", conditions: [{ field: "method", op: "eq", value: "GET" }] },
    });
    const requestId = await capture(e.slug, { type: "x" });
    await drain(e.id);
    expect((await deliveries(e.id))[0].status).toBe("skipped");
    const id = await queueDestinationRedelivery(requestId, destination.id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await drain(e.id);
    expect(rows.find((row) => row.id === id)).toMatchObject({
      status: "succeeded",
      bypass_filter: true,
    });
  });

  it("keeps the old notificationUrl working as a throttled chat destination", async () => {
    const e = await endpoint();
    const updated = await updateEndpointBySlugForUser({
      userId,
      slug: e.slug,
      notificationUrl: `${base}/notify`,
    });
    expect(updated?.notificationUrl).toBe(`${base}/notify`);
    const [notify] = await listDestinations(e.id);
    expect(notify).toMatchObject({
      role: "notify",
      format: "chat",
      throttleSeconds: 1,
      retrySeconds: 0,
    });
    const cleared = await updateEndpointBySlugForUser({
      userId,
      slug: e.slug,
      notificationUrl: null,
    });
    expect(cleared?.notificationUrl).toBeNull();
    expect(await listDestinations(e.id)).toEqual([]);
  });
});
