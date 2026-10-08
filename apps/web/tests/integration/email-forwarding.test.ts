import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyStandardWebhookSignature } from "@webhooks-cc/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser, updateEndpointBySlugForUser } from "@/lib/supabase/endpoints";
import { getForwardSecret } from "@/lib/supabase/forwarding";
import { runForwardingBatch } from "@/lib/forwarding/worker";

/**
 * Email forwarding against the local database (migration 00050) and a local
 * HTTP server standing in for the user's. Needs FORWARDING_ALLOW_PRIVATE_TARGETS
 * (as in .env.local) so deliveries may go to 127.0.0.1. A running dev server
 * drains the same queue with its own worker; the assertions hold whichever
 * process sends.
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
const received: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-forwarding-${Date.now()}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  userId = data.user!.id;

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body });
      if (req.url === "/down") res.writeHead(503).end("busy");
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

async function forwardingEndpoint(path: string, enabled = true) {
  const endpoint = await createEndpointForUser({ userId, name: "Forwarding" });
  endpoints.push({ id: endpoint.id, slug: endpoint.slug });
  await updateEndpointBySlugForUser({
    userId,
    slug: endpoint.slug,
    forwardUrl: `${base}${path}`,
    forwardEnabled: enabled,
  });
  return endpoint;
}

async function capture(slug: string, kind: "email" | "http" = "email") {
  const email = kind === "email";
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
    p_method: email ? "EMAIL" : "POST",
    p_path: email ? `${slug}@mailhooks.cc` : "/",
    p_headers: { subject: "Hello" },
    p_body: email ? "Subject: Hello\r\n\r\nYour code is 482913.\r\n" : "{}",
    p_query_params: {},
    p_content_type: email ? "message/rfc822" : "application/json",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
    p_body_raw: null,
    ...(email
      ? {
          p_kind: "email",
          p_email: { subject: "Hello", text: "Your code is 482913." },
          p_dedupe_key: null,
          p_retry: false,
          p_size: null,
        }
      : {}),
  });
  if (error) throw error;
  return (data as { request_id: string }).request_id;
}

async function deliveries(endpointId: string) {
  const { data, error } = await admin
    .from("email_deliveries")
    .select("id, request_id, status, attempts, next_attempt_at, last_status, last_error")
    .eq("endpoint_id", endpointId)
    .order("created_at");
  if (error) throw error;
  return data;
}

/** Runs the worker until the endpoint's deliveries have each been tried once. */
async function drain(endpointId: string) {
  for (let i = 0; i < 40; i++) {
    await runForwardingBatch();
    const rows = await deliveries(endpointId);
    if (
      rows.every((row) => row.attempts > 0 && row.status !== "pending") ||
      rows.every((row) => row.attempts > 0 && row.next_attempt_at > new Date().toISOString())
    ) {
      return rows;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("deliveries were not tried");
}

describe("email forwarding", () => {
  it("makes a secret with the first URL and needs a URL to turn on", async () => {
    const endpoint = await createEndpointForUser({ userId, name: "Setup" });
    endpoints.push({ id: endpoint.id, slug: endpoint.slug });
    await expect(
      updateEndpointBySlugForUser({ userId, slug: endpoint.slug, forwardEnabled: true })
    ).rejects.toThrow("Add a URL before turning forwarding on.");

    const updated = await updateEndpointBySlugForUser({
      userId,
      slug: endpoint.slug,
      forwardUrl: `${base}/hook`,
    });
    expect(updated).toMatchObject({ forwardEnabled: false, hasForwardSecret: true });
    expect(await getForwardSecret(userId, endpoint.slug)).toMatch(/^whsec_/);
  });

  it("queues emails only, and only while forwarding is on", async () => {
    const on = await forwardingEndpoint("/hook");
    const off = await forwardingEndpoint("/hook", false);
    const requestId = await capture(on.slug);
    await capture(on.slug, "http");
    await capture(off.slug);

    expect((await deliveries(on.id)).map((row) => row.request_id)).toEqual([requestId]);
    expect(await deliveries(off.id)).toEqual([]);
  });

  it("delivers the email JSON, signed with the endpoint's secret", async () => {
    const endpoint = await forwardingEndpoint("/ok");
    const requestId = await capture(endpoint.slug);
    const [row] = await drain(endpoint.id);
    expect(row).toMatchObject({ status: "succeeded", attempts: 1, last_status: 200 });

    const delivery = received.find((entry) => entry.body.includes(requestId))!;
    expect(delivery.path).toBe("/ok");
    expect(JSON.parse(delivery.body)).toMatchObject({
      type: "email.received",
      data: {
        id: requestId,
        endpoint: { slug: endpoint.slug },
        subject: "Hello",
        codes: ["482913"],
      },
    });
    const secret = (await getForwardSecret(userId, endpoint.slug))!;
    expect(
      await verifyStandardWebhookSignature(
        delivery.body,
        delivery.headers as Record<string, string>,
        secret
      )
    ).toBe(true);
  });

  it("schedules a retry after a failure and keeps the answer", async () => {
    const endpoint = await forwardingEndpoint("/down");
    await capture(endpoint.slug);
    const [row] = await drain(endpoint.id);
    expect(row).toMatchObject({ status: "pending", attempts: 1, last_status: 503 });
    const waitSeconds = (Date.parse(row.next_attempt_at) - Date.now()) / 1000;
    expect(waitSeconds).toBeGreaterThan(20);
    expect(waitSeconds).toBeLessThanOrEqual(31);

    const { data: attempts } = await admin
      .from("email_delivery_attempts")
      .select("status, response_excerpt, error")
      .eq("delivery_id", row.id);
    expect(attempts).toEqual([
      { status: 503, response_excerpt: "busy", error: "The URL answered 503." },
    ]);
  });

  it("fails a delivery after its last try", async () => {
    const endpoint = await forwardingEndpoint("/down", false);
    const requestId = await capture(endpoint.slug);
    const { data: queued, error } = await admin
      .from("email_deliveries")
      .insert({ request_id: requestId, endpoint_id: endpoint.id })
      .select("id")
      .single();
    if (error) throw error;
    const { error: rpcError } = await admin.rpc("record_email_delivery_attempt", {
      p_delivery_id: queued.id,
      p_attempt: 0,
      p_succeeded: false,
      p_status: 503,
      p_duration_ms: 12,
      p_error: "The URL answered 503.",
      p_response_excerpt: null,
      p_retry_in_seconds: null,
    });
    expect(rpcError).toBeNull();
    expect((await deliveries(endpoint.id))[0]).toMatchObject({
      status: "failed",
      last_error: "The URL answered 503.",
    });
  });

  it("keeps a late result as history without changing a settled or reclaimed delivery", async () => {
    const endpoint = await forwardingEndpoint("/down");
    const requestId = await capture(endpoint.slug);
    const [queued] = await deliveries(endpoint.id);
    // Held by "another worker": leased, so nothing else claims it meanwhile.
    const lease = new Date(Date.now() + 60_000).toISOString();
    await admin
      .from("email_deliveries")
      .update({ attempts: 2, locked_until: lease })
      .eq("id", queued.id);

    const late = (attempt: number) =>
      admin.rpc("record_email_delivery_attempt", {
        p_delivery_id: queued.id,
        p_attempt: attempt,
        p_succeeded: true,
        p_status: 200,
        p_duration_ms: 5,
        p_error: null,
        p_response_excerpt: "ok",
        p_retry_in_seconds: null,
      });

    // A result from the first claim, whose lease another worker took over.
    expect((await late(1)).error).toBeNull();
    expect((await deliveries(endpoint.id))[0]).toMatchObject({ status: "pending", attempts: 2 });

    // Forwarding turned off while the second send ran: its result does not revive it.
    await updateEndpointBySlugForUser({ userId, slug: endpoint.slug, forwardEnabled: false });
    expect((await late(2)).error).toBeNull();
    expect((await deliveries(endpoint.id))[0]).toMatchObject({
      request_id: requestId,
      status: "failed",
      last_error: "Forwarding was turned off.",
    });

    const { data: history } = await admin
      .from("email_delivery_attempts")
      .select("status")
      .eq("delivery_id", queued.id);
    expect(history).toHaveLength(2);
  });

  it("fails a delivery whose sends keep being interrupted", async () => {
    const endpoint = await forwardingEndpoint("/never-reached");
    await capture(endpoint.slug);
    const [queued] = await deliveries(endpoint.id);
    // Twelve claims that never recorded a result.
    await admin
      .from("email_deliveries")
      .update({ attempts: 12, locked_until: null })
      .eq("id", queued.id);
    await runForwardingBatch();
    expect((await deliveries(endpoint.id))[0]).toMatchObject({
      status: "failed",
      last_error: "The delivery was interrupted too many times.",
    });
  });

  it("never hands one delivery to two claims", async () => {
    const endpoint = await forwardingEndpoint("/slow-never-sent");
    // Two claims at once over six due deliveries (a running dev server's
    // worker may take some too; it cannot take the same ones either).
    for (let i = 0; i < 6; i++) await capture(endpoint.slug);
    const [a, b] = await Promise.all([
      admin.rpc("claim_email_deliveries", { p_limit: 10, p_per_endpoint: 10, p_lease_seconds: 60 }),
      admin.rpc("claim_email_deliveries", { p_limit: 10, p_per_endpoint: 10, p_lease_seconds: 60 }),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    const ids = [...(a.data ?? []), ...(b.data ?? [])].map((claim) => claim.delivery_id);
    expect(new Set(ids).size).toBe(ids.length);
    // Release the leases; whatever sends them next gets a 200.
    await admin
      .from("email_deliveries")
      .update({ locked_until: null })
      .eq("endpoint_id", endpoint.id);
  });

  it("fails what is waiting when forwarding is turned off", async () => {
    const endpoint = await forwardingEndpoint("/down");
    await capture(endpoint.slug);
    await drain(endpoint.id);
    await updateEndpointBySlugForUser({ userId, slug: endpoint.slug, forwardEnabled: false });
    expect((await deliveries(endpoint.id))[0]).toMatchObject({
      status: "failed",
      last_error: "Forwarding was turned off.",
    });
  });
});
