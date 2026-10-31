import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser, updateEndpointBySlugForUser } from "@/lib/supabase/endpoints";
import { createDestination } from "@/lib/supabase/destinations";
import { runForwardingBatch } from "@/lib/forwarding/worker";
import { getObjectBytes, isObjectStorageConfigured, putObject } from "@/lib/storage/object-store";
import { saveAlertSettings, DEFAULT_ALERT_SETTINGS } from "@/lib/supabase/alerts";
import { runAlertChecks } from "@/lib/alerts/checker";
import { replayRequests, requestIdsInRange } from "@/lib/replay";
import { notifyAlerts } from "@/lib/alerts/notify";
import { getLastMessageForEmail } from "@/lib/email/dev-transport";
import { GET as attachmentLinkRoute } from "@/app/api/attachments/[id]/[index]/route";

/**
 * Attachment contents in deliveries, replay and alerts (migration 00068),
 * against the local database and object storage, with a local HTTP server
 * standing in for the owner's. Runs in the forwarding group: it drives the
 * forwarding worker in this process.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let userId: string;
let ownerEmail: string;
const endpointIds: string[] = [];
let server: Server;
let base: string;
const received: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  ownerEmail = `test-attachments-alerts-${Date.now()}@webhooks-test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email: ownerEmail,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  userId = data.user!.id;
  await admin.from("users").update({ plan: "pro", request_limit: 100_000 }).eq("id", userId);

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(req.url === "/down" ? 500 : 200).end("{}");
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
    await admin.from("endpoints").delete().eq("id", id);
  }
  if (userId) await admin.auth.admin.deleteUser(userId);
});

async function endpoint(name: string) {
  const created = await createEndpointForUser({ userId, name });
  endpointIds.push(created.id);
  return created;
}

async function captureEmail(
  slug: string,
  subject: string,
  options: { requestId?: string; attachments?: unknown[]; stored?: boolean } = {}
): Promise<string> {
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
    p_method: "EMAIL",
    p_path: `${slug}@mailhooks.cc`,
    p_headers: { subject },
    p_body: `Subject: ${subject}\r\n\r\nbody\r\n`,
    p_query_params: {},
    p_content_type: "message/rfc822",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
    p_kind: "email",
    p_email: {
      subject,
      text: "body",
      attachments: options.attachments ?? [],
      ...(options.stored ? { raw_stored: true } : {}),
    },
    ...(options.requestId
      ? { p_request_id: options.requestId, p_object_prefix: `m/${options.requestId}/` }
      : {}),
  });
  if (error) throw error;
  return (data as { request_id: string }).request_id;
}

async function drain(endpointId: string) {
  for (let i = 0; i < 20; i++) {
    await runForwardingBatch(16);
    const { data } = await admin
      .from("email_deliveries")
      .select("id")
      .eq("endpoint_id", endpointId)
      .eq("status", "pending");
    if (!data || data.length === 0) return;
  }
}

describe.skipIf(!isObjectStorageConfigured())("attachments in deliveries", () => {
  it("sends contents inline up to the budget and links for the rest", async () => {
    const target = await endpoint("attachments");
    const inline = await createDestination(target.id, {
      url: `${base}/inline`,
      format: "json",
      attachments: "inline",
      email: true,
      http: false,
    });
    const links = await createDestination(target.id, {
      url: `${base}/links`,
      format: "cloudmailin",
      attachments: "links",
      email: true,
      http: false,
    });
    expect(inline.attachments).toBe("inline");
    expect(links.attachments).toBe("links");

    const requestId = crypto.randomUUID();
    const csv = "sku,qty\nA-1,2\n";
    const big = Buffer.alloc(1100 * 1024, 7);
    await putObject(`m/${requestId}/raw.eml`, "Subject: Orders\r\n\r\nbody\r\n", "message/rfc822");
    await putObject(`m/${requestId}/a/0`, csv, "application/octet-stream");
    await putObject(`m/${requestId}/a/1`, big, "application/octet-stream");
    await captureEmail(target.slug, "Orders", {
      requestId,
      stored: true,
      attachments: [
        { filename: "orders.csv", content_type: "text/csv", size: csv.length, inline: false },
        {
          filename: "big.bin",
          content_type: "application/octet-stream",
          size: big.length,
          inline: false,
        },
      ],
    });
    await drain(target.id);

    const inlineBody = JSON.parse(received.find((r) => r.path === "/inline")!.body);
    const [first, second] = inlineBody.data.attachments;
    expect(Buffer.from(first.content, "base64").toString()).toBe(csv);
    expect(first.url).toBeUndefined();
    expect(second.content).toBeUndefined();
    expect(second.url).toContain(`/api/attachments/${requestId}/1?e=`);

    const linksBody = JSON.parse(received.find((r) => r.path === "/links")!.body);
    expect(linksBody.attachments).toHaveLength(2);
    expect(linksBody.attachments[0]).toMatchObject({
      file_name: "orders.csv",
      content_type: "text/csv",
    });
    const link = new URL(linksBody.attachments[0].url);

    // The link answers with a short-lived storage link that downloads the bytes.
    const response = await attachmentLinkRoute(new Request(link), {
      params: Promise.resolve({ id: requestId, index: "0" }),
    });
    expect(response.status).toBe(302);
    const download = await fetch(response.headers.get("location")!);
    expect(await download.text()).toBe(csv);
    expect(download.headers.get("content-disposition")).toContain("orders.csv");

    // A changed signature or a later index is refused.
    const forged = new URL(link);
    forged.searchParams.set("s", "x" + forged.searchParams.get("s")!.slice(1));
    const refused = await attachmentLinkRoute(new Request(forged), {
      params: Promise.resolve({ id: requestId, index: "0" }),
    });
    expect(refused.status).toBe(403);
    const otherIndex = await attachmentLinkRoute(new Request(link), {
      params: Promise.resolve({ id: requestId, index: "1" }),
    });
    expect(otherIndex.status).toBe(403);
    expect((await getObjectBytes(`m/${requestId}/a/0`))?.toString()).toBe(csv);
  });

  it("sends names only when the destination says so", async () => {
    const target = await endpoint("names only");
    await createDestination(target.id, {
      url: `${base}/names`,
      format: "json",
      attachments: "none",
      email: true,
      http: false,
    });
    const requestId = crypto.randomUUID();
    await putObject(`m/${requestId}/a/0`, "x", "application/octet-stream");
    await captureEmail(target.slug, "Names", {
      requestId,
      stored: true,
      attachments: [{ filename: "x.txt", content_type: "text/plain", size: 1, inline: false }],
    });
    await drain(target.id);
    const body = JSON.parse(received.find((r) => r.path === "/names")!.body);
    expect(body.data.attachments[0]).toEqual({
      filename: "x.txt",
      contentType: "text/plain",
      size: 1,
      contentId: null,
      inline: false,
    });
  });
});

describe("replay", () => {
  it("queues a captured request to every destination again", async () => {
    const target = await endpoint("replay");
    await updateEndpointBySlugForUser({
      userId,
      slug: target.slug,
      forwardUrl: `${base}/replay`,
      forwardEnabled: true,
    });
    await createDestination(target.id, { url: `${base}/replay-b`, format: "json", email: true });
    const requestId = await captureEmail(target.slug, "Replay me");
    await drain(target.id);
    const count = (path: string) => received.filter((r) => r.path === path).length;
    const before = [count("/replay"), count("/replay-b")];
    expect(await replayRequests(target.id, [requestId])).toBe(1);
    await drain(target.id);
    // Each destination gets it once more.
    expect([count("/replay"), count("/replay-b")]).toEqual([before[0] + 1, before[1] + 1]);
  });

  it("treats a bound of 0 as a bound", async () => {
    const target = await endpoint("replay range");
    await captureEmail(target.slug, "In range");
    expect(await requestIdsInRange(target.id, { until: 0 })).toEqual([]);
    expect(await requestIdsInRange(target.id, { since: 0 })).toHaveLength(1);
  });
});

async function dueNow(endpointId: string) {
  await admin
    .from("endpoint_alerts")
    .update({ next_check_at: new Date().toISOString(), locked_until: null })
    .eq("endpoint_id", endpointId);
}

async function openAlerts(endpointId: string) {
  const { data } = await admin
    .from("alert_events")
    .select("kind, subject, resolved_at, details, notified_open_at")
    .eq("endpoint_id", endpointId)
    .order("opened_at");
  return data ?? [];
}

describe("alerts", () => {
  it("keeps only destinations that can take a notice", async () => {
    const target = await endpoint("alerts targets");
    const notify = await createDestination(target.id, {
      url: `${base}/alerts-targets`,
      format: "json",
      email: false,
      http: false,
    });
    const drop = await createDestination(target.id, {
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
      },
      dropSecret: { password: "x" },
    });
    const saved = await saveAlertSettings(target.id, {
      ...DEFAULT_ALERT_SETTINGS,
      enabled: true,
      notifyDestinationIds: [notify.id, drop.id],
    });
    expect(saved.notifyDestinationIds).toEqual([notify.id]);
  });

  it("leaves a notice another pass has claimed until that claim runs out", async () => {
    const target = await endpoint("alerts claimed");
    const notify = await createDestination(target.id, {
      url: `${base}/alerts-claimed`,
      format: "json",
      email: false,
      http: false,
    });
    await saveAlertSettings(target.id, {
      ...DEFAULT_ALERT_SETTINGS,
      enabled: true,
      notifyEmail: false,
      notifyDestinationIds: [notify.id],
    });
    const { data: event, error } = await admin
      .from("alert_events")
      .insert({ endpoint_id: target.id, kind: "silence", details: { hours: 6 } })
      .select("id")
      .single();
    if (error) throw error;
    const sent = () => received.filter((r) => r.path === "/alerts-claimed").length;

    // A first pass claimed it (claim_alert_notices) and is still sending: a
    // second pass started now leaves it alone.
    await admin
      .from("alert_events")
      .update({ notify_claimed_until: new Date(Date.now() + 120_000).toISOString() })
      .eq("id", event.id);
    await notifyAlerts();
    expect(sent()).toBe(0);

    // The first pass died and its claim ran out: a later pass sends it, once.
    await admin
      .from("alert_events")
      .update({ notify_claimed_until: new Date(Date.now() - 1_000).toISOString() })
      .eq("id", event.id);
    await notifyAlerts();
    await notifyAlerts();
    expect(sent()).toBe(1);
  });

  it("sends a notice once when two passes run at the same time", async () => {
    const target = await endpoint("alerts once");
    const notify = await createDestination(target.id, {
      url: `${base}/alerts-once`,
      format: "json",
      email: false,
      http: false,
    });
    await saveAlertSettings(target.id, {
      ...DEFAULT_ALERT_SETTINGS,
      enabled: true,
      notifyEmail: false,
      notifyDestinationIds: [notify.id],
    });
    const { error } = await admin
      .from("alert_events")
      .insert({ endpoint_id: target.id, kind: "silence", details: { hours: 6 } });
    if (error) throw error;
    await Promise.all([notifyAlerts(), notifyAlerts()]);
    expect(received.filter((r) => r.path === "/alerts-once")).toHaveLength(1);
  });

  it("opens when fields stop matching, notifies, and resolves when they match again", async () => {
    const target = await endpoint("alerts fields");
    await updateEndpointBySlugForUser({
      userId,
      slug: target.slug,
      emailFields: [{ name: "order", from: "subject", pattern: "Order #(\\d+)" }],
    });
    const notify = await createDestination(target.id, {
      url: `${base}/alerts`,
      format: "json",
      email: false,
      http: false,
    });
    await saveAlertSettings(target.id, {
      ...DEFAULT_ALERT_SETTINGS,
      enabled: true,
      fieldFailures: 2,
      destinationFailures: false,
      notifyDestinationIds: [notify.id],
    });
    // Before the alerts' start: not counted.
    await captureEmail(target.slug, "Order #1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await captureEmail(target.slug, "Your receipt");
    await dueNow(target.id);
    await runAlertChecks();
    expect((await openAlerts(target.id)).length).toBe(0);

    await captureEmail(target.slug, "Your receipt again");
    await dueNow(target.id);
    await runAlertChecks();
    const [opened] = await openAlerts(target.id);
    expect(opened).toMatchObject({ kind: "fields", resolved_at: null });
    expect((opened.details as { missing: string[] }).missing).toEqual(["order"]);
    expect(opened.notified_open_at).not.toBeNull();
    const notice = received.filter((r) => r.path === "/alerts").at(-1)!;
    expect(JSON.parse(notice.body)).toMatchObject({
      type: "alert.opened",
      data: { kind: "fields", endpoint: { slug: target.slug } },
    });
    expect(notice.headers["webhook-signature"]).toMatch(/^v1,/);
    expect(getLastMessageForEmail(ownerEmail)?.subject).toContain("order stopped matching");

    await captureEmail(target.slug, "Order #2");
    await dueNow(target.id);
    await runAlertChecks();
    const [resolved] = await openAlerts(target.id);
    expect(resolved.resolved_at).not.toBeNull();
    expect(JSON.parse(received.filter((r) => r.path === "/alerts").at(-1)!.body).type).toBe(
      "alert.resolved"
    );
    expect(getLastMessageForEmail(ownerEmail)?.subject).toMatch(/^Resolved:/);
  });

  it("scores each email once, however many arrive within the hour", async () => {
    const target = await endpoint("alerts burst");
    await updateEndpointBySlugForUser({
      userId,
      slug: target.slug,
      emailFields: [{ name: "order", from: "subject", pattern: "Order #(\\d+)" }],
    });
    // Counts misses only: the alert never opens at this threshold.
    await saveAlertSettings(target.id, {
      ...DEFAULT_ALERT_SETTINGS,
      enabled: true,
      fieldFailures: 100,
      destinationFailures: false,
      notifyEmail: false,
    });
    // 800 emails in the last 40 minutes, more than the 500 ids the checker
    // remembers: before the fix, older ones were scored again and the cursor
    // stopped moving.
    const start = Date.now() - 40 * 60_000;
    const rows = Array.from({ length: 800 }, (_, i) => ({
      endpoint_id: target.id,
      user_id: userId,
      method: "EMAIL",
      path: `${target.slug}@mailhooks.cc`,
      ip: "192.0.2.10",
      kind: "email",
      received_at: new Date(start + i * 3000).toISOString(),
      email: { subject: `Receipt ${i}`, text: "no order here" },
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await admin.from("requests").insert(rows.slice(i, i + 200));
      if (error) throw error;
    }
    await admin
      .from("endpoint_alerts")
      .update({ created_at: new Date(start - 60_000).toISOString() })
      .eq("endpoint_id", target.id);
    for (let i = 0; i < 6; i++) {
      await dueNow(target.id);
      await runAlertChecks();
    }
    const { data } = await admin
      .from("endpoint_alerts")
      .select("failure_streak, checked_through")
      .eq("endpoint_id", target.id)
      .single();
    expect(data!.failure_streak).toBe(800);
    expect(Date.parse(data!.checked_through!)).toBe(Date.parse(rows[799].received_at));
  });

  it("opens a silence alert when no email arrives for the hours set", async () => {
    const target = await endpoint("alerts silence");
    await saveAlertSettings(target.id, {
      ...DEFAULT_ALERT_SETTINGS,
      enabled: true,
      fieldFailures: null,
      silenceHours: 1,
      destinationFailures: false,
    });
    await admin
      .from("endpoint_alerts")
      .update({ created_at: new Date(Date.now() - 2 * 3_600_000).toISOString() })
      .eq("endpoint_id", target.id);
    await dueNow(target.id);
    await runAlertChecks();
    expect((await openAlerts(target.id))[0]).toMatchObject({ kind: "silence", resolved_at: null });

    await captureEmail(target.slug, "Hello again");
    await dueNow(target.id);
    await runAlertChecks();
    expect((await openAlerts(target.id))[0].resolved_at).not.toBeNull();
  });

  it("opens per destination when a delivery fails for good", async () => {
    const target = await endpoint("alerts destinations");
    const destination = await createDestination(target.id, {
      url: `${base}/down`,
      format: "json",
      retrySeconds: 0,
      email: true,
      http: false,
    });
    await saveAlertSettings(target.id, {
      ...DEFAULT_ALERT_SETTINGS,
      enabled: true,
      fieldFailures: null,
      destinationFailures: true,
    });
    await captureEmail(target.slug, "Will fail");
    await drain(target.id);
    await dueNow(target.id);
    await runAlertChecks();
    const [alert] = await openAlerts(target.id);
    expect(alert).toMatchObject({
      kind: "destination",
      subject: destination.id,
      resolved_at: null,
    });
    expect((alert.details as { failed: number }).failed).toBe(1);
  });
});
