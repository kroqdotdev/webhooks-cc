import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Layout, ParsedEmail } from "@webhooks-cc/sdk/email";
import { createEndpointForUser, updateEndpointBySlugForUser } from "@/lib/supabase/endpoints";
import { createDestination } from "@/lib/supabase/destinations";
import { saveAlertSettings, DEFAULT_ALERT_SETTINGS } from "@/lib/supabase/alerts";
import { runAlertChecks } from "@/lib/alerts/checker";
import { NO_LAYOUT } from "@/lib/alerts/state";
import { runForwardingBatch } from "@/lib/forwarding/worker";
import { runParseBatch } from "@/lib/parsing/worker";
import { parserPath } from "@/lib/parsing/parser";
import { replayRequests } from "@/lib/replay";
import { isObjectStorageConfigured, putObject } from "@/lib/storage/object-store";

/**
 * Layouts and the parse step (migration 00069) against the local database,
 * object storage and the real sandboxed parser (apps/parser-rs, built with
 * `cargo build --release`): which layout an email matches, its fields and
 * line items, attachment parsing with page metering and the taste limit,
 * deliveries waiting for the parse, replay re-parsing without charging
 * twice, and alerts on emails no layout matched. Runs in the forwarding
 * group: it drives the parse and forwarding workers in this process.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ready = isObjectStorageConfigured() && parserPath() !== null;
const ts = Date.now();
let counter = 0;
const userIds: string[] = [];
const endpointIds: string[] = [];
let server: Server;
let base: string;
const received: { path: string; body: string }[] = [];

const DAY = 86_400_000;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", body });
      res.writeHead(200).end("{}");
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
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

async function createUser(fields: Record<string, unknown>): Promise<string> {
  counter += 1;
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-parsing-${counter}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  const id = data.user!.id;
  userIds.push(id);
  const { error: updateError } = await admin.from("users").update(fields).eq("id", id);
  if (updateError) throw updateError;
  return id;
}

const proUser = () =>
  createUser({
    plan: "pro",
    request_limit: 100_000,
    subscription_status: "active",
    period_start: new Date(Date.now() - DAY).toISOString(),
    period_end: new Date(Date.now() + 29 * DAY).toISOString(),
  });

const LAYOUTS: Layout[] = [
  {
    id: "orders",
    name: "Orders",
    match: { conditions: [{ field: "email", name: "subject", op: "contains", value: "Order" }] },
    fields: [{ name: "order", from: "subject", pattern: "Order (\\d+)" }],
    lineItems: { from: "attachment", attachment: "*.csv" },
  },
  {
    id: "shipping",
    name: "Shipping",
    match: { conditions: [{ field: "email", name: "subject", op: "contains", value: "Shipped" }] },
    lineItems: {
      from: "text",
      start: "Items:",
      end: "Thanks",
      pattern: "(?P<sku>[A-Z]-\\d+) x(?P<qty>\\d+)",
    },
  },
  {
    id: "invoices",
    name: "Invoices",
    match: { conditions: [{ field: "email", name: "subject", op: "contains", value: "Invoice" }] },
    parseAttachments: true,
  },
];

async function endpointWithLayouts(userId: string, name: string, layouts = LAYOUTS) {
  const endpoint = await createEndpointForUser({ userId, name });
  endpointIds.push(endpoint.id);
  await updateEndpointBySlugForUser({ userId, slug: endpoint.slug, layouts });
  await createDestination(endpoint.id, {
    url: `${base}/${endpoint.slug}`,
    format: "json",
    email: true,
    http: false,
  });
  return endpoint;
}

type Attachment = { filename: string; contentType: string; bytes: Buffer };

async function captureEmail(
  slug: string,
  subject: string,
  text = "body",
  attachments: Attachment[] = []
): Promise<string> {
  const requestId = crypto.randomUUID();
  for (const [index, attachment] of attachments.entries()) {
    await putObject(`m/${requestId}/a/${index}`, attachment.bytes, attachment.contentType);
  }
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
    p_method: "EMAIL",
    p_path: `${slug}@mailhooks.cc`,
    p_headers: { subject },
    p_body: `Subject: ${subject}\r\n\r\n${text}\r\n`,
    p_query_params: {},
    p_content_type: "message/rfc822",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
    p_kind: "email",
    p_email: {
      subject,
      text,
      from: [{ name: null, address: "orders@acme.example" }],
      raw_stored: true,
      attachments: attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.bytes.length,
      })),
    },
    p_request_id: requestId,
    p_object_prefix: `m/${requestId}/`,
  });
  if (error) throw error;
  return (data as { request_id: string }).request_id;
}

/** Parses until the email's job is done (the dev server's worker may take it first). */
async function parsed(requestId: string): Promise<{ status: string; result: ParsedEmail | null }> {
  for (let i = 0; i < 40; i++) {
    const { data } = await admin
      .from("request_parses")
      .select("status, result")
      .eq("request_id", requestId)
      .single();
    if (data && data.status !== "pending") {
      return data as { status: string; result: ParsedEmail | null };
    }
    await runParseBatch(4);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the parse did not finish");
}

async function deliveries(requestId: string) {
  const { data, error } = await admin
    .from("email_deliveries")
    .select("id, status")
    .eq("request_id", requestId);
  if (error) throw error;
  return data ?? [];
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

async function pagesUsed(userId: string): Promise<number> {
  const { data } = await admin.from("users").select("pages_used").eq("id", userId).single();
  return (data as { pages_used: number }).pages_used;
}

/** A PDF with one line of text per page. */
function simplePdf(texts: string[]): Buffer {
  const objects: string[] = [];
  const pageIds = texts.map((_, i) => 4 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${texts.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  texts.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects[pageIds[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
    objects[pageIds[i] + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const csv = (rows: number) =>
  Buffer.from(
    ["sku,qty", ...Array.from({ length: rows }, (_, i) => `S-${i + 1},${i + 1}`)].join("\n")
  );

describe.skipIf(!ready)("layouts and the parse step", () => {
  it("matches a layout, reads a CSV into line items, charges its page, then delivers", async () => {
    const userId = await proUser();
    const endpoint = await endpointWithLayouts(userId, "orders");
    const id = await captureEmail(endpoint.slug, "Order 1001", "See attached.", [
      { filename: "order.csv", contentType: "text/csv", bytes: csv(2) },
    ]);
    // Deliveries wait for the parse.
    expect(await deliveries(id)).toHaveLength(0);

    const parse = await parsed(id);
    expect(parse.status).toBe("done");
    const result = parse.result!;
    expect(result.status).toBe("matched");
    expect(result.layout).toEqual({ id: "orders", name: "Orders" });
    expect(result.fields).toEqual({ order: "1001" });
    expect(result.lineItems).toEqual([
      { sku: "S-1", qty: "1" },
      { sku: "S-2", qty: "2" },
    ]);
    expect(result.attachments[0]).toMatchObject({ index: 0, format: "csv", pages: 1 });
    expect(result.pages).toBe(1);
    expect(await pagesUsed(userId)).toBe(1);

    expect(await deliveries(id)).toHaveLength(1);
    await drain(endpoint.id);
    const sent = received.filter((item) => item.path === `/${endpoint.slug}`);
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0].body) as { data: { parsed: ParsedEmail } };
    expect(body.data.parsed.layout?.id).toBe("orders");
    expect(body.data.parsed.lineItems).toHaveLength(2);
  });

  it("counts a CSV page per started 1,000 rows and a PDF page per page", async () => {
    const userId = await proUser();
    const endpoint = await endpointWithLayouts(userId, "pages", [LAYOUTS[2]]);
    const id = await captureEmail(endpoint.slug, "Invoice 7", "Attached.", [
      { filename: "rows.csv", contentType: "text/csv", bytes: csv(2500) },
      {
        filename: "invoice.pdf",
        contentType: "application/pdf",
        bytes: simplePdf(["Page one", "Page two", "Page three"]),
      },
      { filename: "logo.png", contentType: "image/png", bytes: Buffer.from("png") },
    ]);
    const result = (await parsed(id)).result!;
    expect(result.layout?.id).toBe("invoices");
    expect(result.attachments.map((item) => [item.format, item.pages])).toEqual([
      ["csv", 3],
      ["pdf", 3],
    ]);
    expect(result.attachments[1].text).toContain("Page two");
    expect(result.pages).toBe(6);
    expect(await pagesUsed(userId)).toBe(6);
  });

  it("finds line items in the text between the markers", async () => {
    const userId = await proUser();
    const endpoint = await endpointWithLayouts(userId, "shipping");
    const id = await captureEmail(
      endpoint.slug,
      "Shipped: your order",
      "Hello\nItems:\nA-1 x2\nB-22 x10\nThanks\nZ-9 x1\n"
    );
    const result = (await parsed(id)).result!;
    expect(result.layout?.id).toBe("shipping");
    expect(result.lineItems).toEqual([
      { sku: "A-1", qty: "2" },
      { sku: "B-22", qty: "10" },
    ]);
    expect(result.pages).toBe(0);
  });

  it("delivers an email no layout matched, and alerts on it", async () => {
    const userId = await proUser();
    const endpoint = await endpointWithLayouts(userId, "no layout");
    await saveAlertSettings(endpoint.id, {
      ...DEFAULT_ALERT_SETTINGS,
      enabled: true,
      fieldFailures: 1,
      notifyEmail: false,
    });
    const id = await captureEmail(endpoint.slug, "Newsletter");
    const parse = await parsed(id);
    expect(parse.result?.status).toBe("no_layout");
    expect(await deliveries(id)).toHaveLength(1);

    await admin
      .from("endpoint_alerts")
      .update({ next_check_at: new Date(0).toISOString() })
      .eq("endpoint_id", endpoint.id);
    await runAlertChecks();
    const { data: events } = await admin
      .from("alert_events")
      .select("kind, details, resolved_at")
      .eq("endpoint_id", endpoint.id);
    expect(events).toHaveLength(1);
    expect(events![0].kind).toBe("fields");
    expect((events![0].details as { missing: string[] }).missing).toEqual([NO_LAYOUT]);
  });

  it("re-parses on replay without charging the pages again, and redelivers", async () => {
    const userId = await proUser();
    const endpoint = await endpointWithLayouts(userId, "replay");
    const id = await captureEmail(endpoint.slug, "Order 2002", "See attached.", [
      { filename: "order.csv", contentType: "text/csv", bytes: csv(3) },
    ]);
    await parsed(id);
    expect(await pagesUsed(userId)).toBe(1);
    await drain(endpoint.id);

    // The owner fixes a layout, then replays.
    await updateEndpointBySlugForUser({
      userId,
      slug: endpoint.slug,
      layouts: [
        {
          ...LAYOUTS[0],
          lineItems: { from: "attachment", columns: [{ name: "item", column: "sku" }] },
        },
      ],
    });
    expect(await replayRequests(endpoint.id, [id])).toBe(1);
    const result = (await parsed(id)).result!;
    expect(result.lineItems).toEqual([{ item: "S-1" }, { item: "S-2" }, { item: "S-3" }]);
    expect(result.pages).toBe(0);
    expect(await pagesUsed(userId)).toBe(1);
    expect(await deliveries(id)).toHaveLength(2);
  });

  it("stops parsing at the taste limit and still delivers the email", async () => {
    const userId = await createUser({ plan: "free" });
    const endpoint = await endpointWithLayouts(userId, "taste", [LAYOUTS[2]]);
    // 18 of Free's 20 pages used this month.
    await admin
      .from("users")
      .update({ pages_used: 18, pages_period_start: new Date(Date.now() - DAY).toISOString() })
      .eq("id", userId);
    const pdf = simplePdf(["One", "Two", "Three"]);
    const first = await captureEmail(endpoint.slug, "Invoice 1", "x", [
      { filename: "a.pdf", contentType: "application/pdf", bytes: pdf },
    ]);
    const firstResult = (await parsed(first)).result!;
    // What was left: two pages, the rest cut off.
    expect(firstResult.attachments[0]).toMatchObject({ pages: 2, truncated: true });
    expect(await pagesUsed(userId)).toBe(20);

    const second = await captureEmail(endpoint.slug, "Invoice 2", "x", [
      { filename: "b.pdf", contentType: "application/pdf", bytes: pdf },
    ]);
    const secondResult = (await parsed(second)).result!;
    expect(secondResult.attachments[0]).toMatchObject({ pages: 0, error: "limit" });
    expect(await pagesUsed(userId)).toBe(20);
    expect(await deliveries(second)).toHaveLength(1);
  });

  it("caps layouts by the billing account's plan", async () => {
    const free = await createUser({ plan: "free" });
    const business = await createUser({ plan: "business", request_limit: 250_000 });
    const a = await createEndpointForUser({ userId: free, name: "cap free" });
    const b = await createEndpointForUser({ userId: business, name: "cap business" });
    endpointIds.push(a.id, b.id);
    const { data } = await admin.from("endpoints").select("id, layouts_cap").in("id", [a.id, b.id]);
    const caps = Object.fromEntries((data ?? []).map((row) => [row.id, row.layouts_cap]));
    expect(caps[a.id]).toBe(2);
    expect(caps[b.id]).toBe(50);

    // Layouts past the cap are kept but never matched.
    await updateEndpointBySlugForUser({ userId: free, slug: a.slug, layouts: LAYOUTS });
    await createDestination(a.id, { url: `${base}/cap`, format: "json", email: true, http: false });
    const id = await captureEmail(a.slug, "Invoice 9");
    expect((await parsed(id)).result?.status).toBe("no_layout");
  });
});
