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
import { saveGoogleConnection } from "@/lib/supabase/google-connections";
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
    // As a Zapier or Make hook: the URL itself, nothing appended.
    const gone = await createDestination(e.id, { url: `${base}/gone`, appendPath: false });
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

  it("keeps a destination on when a 410 answers a path appended to its URL", async () => {
    const e = await endpoint();
    // The request's path (/events) goes after the URL: a 410 there is about that resource.
    const relay = await createDestination(e.id, { url: `${base}/gone/append`, appendPath: true });
    await capture(e.slug, { type: "x" });
    await runForwardingBatch();
    expect(at("/gone/append/events").length).toBeGreaterThan(0);
    const { data: destination } = await admin
      .from("endpoint_destinations")
      .select("enabled")
      .eq("id", relay.id)
      .single();
    expect(destination?.enabled).toBe(true);
  });

  it("settles deliveries queued for a gone URL without sending them", async () => {
    const e = await endpoint();
    await createDestination(e.id, { url: `${base}/gone/queued`, appendPath: false });
    for (const type of ["a", "b", "c"]) await capture(e.slug, { type });
    const sentBefore = at("/gone/queued").length;
    const rows = await drain(e.id);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status !== "pending")).toBe(true);
    // Once it answered 410, what was still queued was not sent: at most the
    // ones already on their way with the first (two per endpoint at a time).
    const sent = at("/gone/queued").length - sentBefore;
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(sent).toBeLessThan(3);
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

/**
 * Changing a destination's format through the API (PATCH, against the web
 * server at WEB_URL, default :3000): a Sheets destination or a file drop
 * that moves to another format needs a URL of its own and leaves its
 * config and drop secret behind, and only those two formats take a config.
 */
describe("destinations through the API: formats and their configs", () => {
  const WEB = (process.env.WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const spreadsheetId = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const sheetsConfig = {
    connectionId: "4b3a2f1e-0d9c-4b8a-9f7e-6d5c4b3a2f1e",
    spreadsheetId,
    sheet: "Orders",
    rows: "email",
    columns: [{ header: "Subject", value: "{{ subject }}" }],
  };
  let token: string;

  beforeAll(async () => {
    const up = await fetch(`${WEB}/.well-known/oauth-authorization-server`).catch(() => null);
    if (!up?.ok) {
      throw new Error(
        `Start the web server at ${WEB} (EMAIL_FORWARDING_WORKER=false), or set WEB_URL`
      );
    }
    const { data } = await admin.auth.admin.getUserById(userId);
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: session, error } = await anon.auth.signInWithPassword({
      email: data.user!.email!,
      password: "TestPassword123!",
    });
    if (error) throw error;
    token = session.session!.access_token;
  });

  function call(method: "POST" | "PATCH", path: string, body: unknown) {
    return fetch(`${WEB}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function row(id: string) {
    const { data, error } = await admin
      .from("endpoint_destinations")
      .select("format, url, config, drop_secret_encrypted")
      .eq("id", id)
      .single();
    if (error) throw error;
    return data;
  }

  it("moves a Sheets destination to json only with a url, and clears its config", async () => {
    const e = await endpoint();
    const sheets = await createDestination(e.id, {
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      format: "sheets",
      email: true,
      http: false,
      config: sheetsConfig,
    });
    const path = `/endpoints/${e.slug}/destinations/${sheets.id}`;

    const refused = await call("PATCH", path, { format: "json" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(
      /^Enter the URL to send to/
    );
    expect(await row(sheets.id)).toMatchObject({ format: "sheets", config: sheetsConfig });

    // A url alone would leave the spreadsheet's URL misleading: refused too.
    const urlAlone = await call("PATCH", path, { url: `${base}/moved` });
    expect(urlAlone.status).toBe(400);
    expect(((await urlAlone.json()) as { error: string }).error).toMatch(
      /^A Google Sheets destination's URL/
    );

    // The preview checks a draft by the same rules.
    const preview = await call("POST", `/endpoints/${e.slug}/destinations/preview`, {
      destinationId: sheets.id,
      destination: { format: "json" },
    });
    expect(preview.status).toBe(400);
    expect(((await preview.json()) as { error: string }).error).toMatch(
      /^Enter the URL to send to/
    );

    const moved = await call("PATCH", path, { format: "json", url: `${base}/moved` });
    expect(moved.status).toBe(200);
    expect(await row(sheets.id)).toMatchObject({
      format: "json",
      url: `${base}/moved`,
      config: null,
    });
    // With its config gone, format "sheets" alone cannot bring the old one back.
    expect((await call("PATCH", path, { format: "sheets" })).status).toBe(400);
  });

  it("moves a file drop to json, clearing its config and secret without asking for it", async () => {
    const e = await endpoint();
    const drop = await createDestination(e.id, {
      url: "sftp://files.acme.example",
      format: "file_drop",
      email: true,
      http: false,
      config: {
        protocol: "sftp",
        host: "files.acme.example",
        port: 22,
        username: "acme",
        folder: "",
        file: "json",
        rows: "email",
        columns: [],
        prefix: "",
        batch: false,
        hostKey: null,
      },
      dropSecret: { password: "x" },
    });
    expect((await row(drop.id)).drop_secret_encrypted).not.toBeNull();
    const path = `/endpoints/${e.slug}/destinations/${drop.id}`;

    expect((await call("PATCH", path, { format: "json" })).status).toBe(400);
    const moved = await call("PATCH", path, { format: "json", url: `${base}/moved` });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { hasDropSecret: boolean }).hasDropSecret).toBe(false);
    expect(await row(drop.id)).toMatchObject({
      format: "json",
      url: `${base}/moved`,
      config: null,
      drop_secret_encrypted: null,
    });
  });

  it("refuses a config on a destination whose format takes none", async () => {
    const e = await endpoint();
    const created = await call("POST", `/endpoints/${e.slug}/destinations`, {
      url: `${base}/json`,
      format: "json",
      config: sheetsConfig,
    });
    expect(created.status).toBe(400);
    expect(((await created.json()) as { error: string }).error).toMatch(
      /^config is for Google Sheets/
    );

    const json = await createDestination(e.id, { url: `${base}/json`, format: "json" });
    const changed = await call("PATCH", `/endpoints/${e.slug}/destinations/${json.id}`, {
      config: sheetsConfig,
    });
    expect(changed.status).toBe(400);
    expect(await row(json.id)).toMatchObject({ format: "json", url: `${base}/json`, config: null });
  });

  it("moves a file drop to a Sheets destination, clearing the drop's secret", async () => {
    const e = await endpoint();
    const connection = await saveGoogleConnection(userId, {
      sub: `sub-destinations-${Date.now()}`,
      email: "owner@acme.example",
      refreshToken: "rt-destinations",
      scopes: "drive.file",
    });
    const drop = await createDestination(e.id, {
      url: "sftp://files.acme.example",
      format: "file_drop",
      email: true,
      http: false,
      config: { protocol: "sftp", host: "files.acme.example", port: 22, username: "acme" },
      dropSecret: { password: "x" },
    });
    const config = { ...sheetsConfig, connectionId: connection.id };
    const moved = await call("PATCH", `/endpoints/${e.slug}/destinations/${drop.id}`, {
      format: "sheets",
      config,
    });
    expect(moved.status).toBe(200);
    expect(await row(drop.id)).toMatchObject({
      format: "sheets",
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      config,
      drop_secret_encrypted: null,
    });
  });

  it("needs the config in the change that switches into sheets or file_drop", async () => {
    const e = await endpoint();
    // A row left with a config its format does not use (as before the API
    // cleared them) must not be picked up by a later switch.
    const stale = await createDestination(e.id, {
      url: `${base}/json`,
      format: "json",
      config: sheetsConfig,
    });
    const path = `/endpoints/${e.slug}/destinations/${stale.id}`;
    for (const format of ["sheets", "file_drop"]) {
      const res = await call("PATCH", path, { format });
      expect(res.status, format).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(
        new RegExp(`^Send the config with format "${format}"`)
      );
    }
    expect(await row(stale.id)).toMatchObject({ format: "json", url: `${base}/json` });
  });

  it("keeps the endpoint's old forward fields off Sheets destinations and drops", async () => {
    const e = await endpoint();
    // The old forward row, since turned into a Sheets destination.
    const sheets = await createDestination(
      e.id,
      {
        url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        format: "sheets",
        email: true,
        http: false,
        config: sheetsConfig,
      },
      "forward"
    );
    const before = await updateEndpointBySlugForUser({ userId, slug: e.slug, name: "Legacy" });
    expect(before).toMatchObject({ forwardEnabled: false, forwardUrl: null });

    const set = await updateEndpointBySlugForUser({
      userId,
      slug: e.slug,
      forwardUrl: `${base}/legacy`,
      forwardFormat: "json",
      forwardEnabled: true,
    });
    expect(set).toMatchObject({
      forwardEnabled: true,
      forwardUrl: `${base}/legacy`,
      forwardFormat: "json",
    });
    expect(await row(sheets.id)).toMatchObject({
      format: "sheets",
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      config: sheetsConfig,
    });
    // A later change goes to the same new destination, not a third one.
    await updateEndpointBySlugForUser({ userId, slug: e.slug, forwardUrl: `${base}/legacy2` });
    const listed = await listDestinations(e.id);
    expect(listed).toHaveLength(2);
    expect(listed.find((d) => d.id !== sheets.id)).toMatchObject({
      url: `${base}/legacy2`,
      format: "json",
      role: null,
    });
  });
});
