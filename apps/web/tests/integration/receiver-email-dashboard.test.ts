import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { extractFromEmail } from "@webhooks-cc/sdk/email";
import {
  createEndpointForUser,
  getEndpointBySlugForUser,
  updateEndpointBySlugForUser,
} from "@/lib/supabase/endpoints";
import {
  listPaginatedRequestsForEndpointByUser,
  listRequestsForEndpointByUser,
} from "@/lib/supabase/requests";
import { searchRequestsForUser } from "@/lib/supabase/search";
import { getUsageForUser } from "@/lib/supabase/usage";
import { buildTestEmail, DELIVER_PATH, signMailRequest, testDeliveryBody } from "@/lib/test-email";

/**
 * What the dashboard reads about captured emails, end to end: a test email
 * goes through the receiver's private mail API exactly as "Send test email"
 * sends it, then comes back through the request list, search, usage and the
 * endpoint settings. Needs the receiver running with its mail listener
 * (`make dev-receiver`); override the address with MAIL_INGEST_URL.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.CAPTURE_SHARED_SECRET;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");
if (!SECRET) throw new Error("CAPTURE_SHARED_SECRET env var required");
const MAIL_URL = (process.env.MAIL_INGEST_URL ?? "http://127.0.0.1:3002").replace(/\/$/, "");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let userId: string;
let endpointId: string;
let slug: string;
let code: string;

async function deliverTestEmail(to: string) {
  const now = new Date();
  const email = buildTestEmail({ to, appUrl: "https://webhooks.cc", now });
  const body = testDeliveryBody({ to, raw: email.raw, now });
  const timestamp = Math.floor(now.getTime() / 1000);
  const res = await fetch(`${MAIL_URL}${DELIVER_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mail-timestamp": String(timestamp),
      "x-mail-signature": signMailRequest(SECRET!, timestamp, "POST", DELIVER_PATH, body),
    },
    body,
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { results: { status: string }[] };
  return { status: data.results[0]?.status, code: email.code };
}

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-email-dashboard-${Date.now()}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  userId = data.user!.id;
  const endpoint = await createEndpointForUser({ userId, name: "Email dashboard" });
  endpointId = endpoint.id;
  slug = endpoint.slug;

  const sent = await deliverTestEmail(`${slug}+welcome@mailhooks.cc`);
  expect(sent.status).toBe("captured");
  code = sent.code;
});

afterAll(async () => {
  if (endpointId) {
    await admin.from("requests").delete().eq("endpoint_id", endpointId);
    await admin.from("endpoint_daily_stats").delete().eq("endpoint_id", endpointId);
    await admin.from("endpoints").update({ request_count: 0 }).eq("id", endpointId);
    await admin.from("endpoints").delete().eq("id", endpointId);
  }
  if (userId) await admin.auth.admin.deleteUser(userId);
});

describe("captured emails in the dashboard's data", () => {
  it("lists the email with its kind and parsed message", async () => {
    const requests = await listRequestsForEndpointByUser({ userId, slug });
    expect(requests).toHaveLength(1);
    const [request] = requests!;
    expect(request.kind).toBe("email");
    expect(request.detectedProvider).toBeNull();
    expect(request.email).toMatchObject({
      subject: "Test email from webhooks.cc",
      from: [{ name: "webhooks.cc", address: "test@webhooks.cc" }],
      to: [{ address: `${slug}+welcome@mailhooks.cc` }],
      tag: "welcome",
      parseError: false,
    });
    expect(request.email?.smtp).toMatchObject({ envelopeFrom: "test@webhooks.cc", test: true });
    // What the "Found in this email" strip shows.
    const found = extractFromEmail(request.email!);
    expect(found.codes).toEqual([code]);
    expect(found.links[0]?.url).toBe("https://webhooks.cc/docs/email-capture");
  });

  it("returns kind and email from search too", async () => {
    const results = await searchRequestsForUser({ userId, slug, q: "Test email" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "email",
      email: { subject: "Test email from webhooks.cc", tag: "welcome" },
    });
  });

  it("splits usage into requests and emails", async () => {
    const usage = await getUsageForUser(userId);
    expect(usage).toMatchObject({ used: 1, emails: 1 });
  });

  it("gives the endpoint an email address and a switch for found codes and links", async () => {
    const endpoint = await getEndpointBySlugForUser(userId, slug);
    expect(endpoint).toMatchObject({
      emailAddress: `${slug}@mailhooks.cc`,
      showEmailExtracts: true,
    });
    const updated = await updateEndpointBySlugForUser({
      userId,
      slug,
      showEmailExtracts: false,
    });
    expect(updated?.showEmailExtracts).toBe(false);
    expect((await getEndpointBySlugForUser(userId, slug))?.showEmailExtracts).toBe(false);
  });

  it("counts emails per billing period, whatever time the email carries", async () => {
    // A renewal or any other reset moves period_start: the earlier count no longer applies.
    const reset = await admin
      .from("users")
      .update({ period_start: new Date().toISOString(), requests_used: 3 })
      .eq("id", userId);
    expect(reset.error).toBeNull();
    expect(await getUsageForUser(userId)).toMatchObject({ used: 3, emails: 0 });

    // An expired Free period: the next capture starts a new one. This email
    // was received 50 minutes earlier (an MX retry), before the period began
    // by the clock, and still counts for it.
    const expired = await admin
      .from("users")
      .update({ period_end: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", userId);
    expect(expired.error).toBeNull();
    const { data, error } = await admin.rpc("capture_webhook", {
      p_slug: slug,
      p_method: "EMAIL",
      p_path: `${slug}@mailhooks.cc`,
      p_headers: { subject: "Retried" },
      p_body: "Subject: Retried\r\n\r\nx\r\n",
      p_query_params: {},
      p_content_type: "message/rfc822",
      p_ip: "192.0.2.10",
      p_received_at: new Date(Date.now() - 50 * 60_000).toISOString(),
      p_body_raw: null,
      p_kind: "email",
      p_email: { subject: "Retried" },
      p_dedupe_key: null,
      p_retry: false,
      p_size: null,
    });
    expect(error).toBeNull();
    expect((data as { status: string }).status).toBe("ok");
    expect(await getUsageForUser(userId)).toMatchObject({ used: 1, emails: 1 });
  });

  it("keeps the exact bytes of an email that is not UTF-8 in search results", async () => {
    // Latin-1 "é": the text body gets a replacement character, body_raw the real byte.
    const raw = Buffer.concat([
      Buffer.from("Subject: Caf", "latin1"),
      Buffer.from([0xe9]),
      Buffer.from(" latin1\r\n\r\nx\r\n", "latin1"),
    ]);
    const { data, error } = await admin.rpc("capture_webhook", {
      p_slug: slug,
      p_method: "EMAIL",
      p_path: `${slug}@mailhooks.cc`,
      p_headers: { subject: "Caf\ufffd latin1" },
      p_body: raw.toString("utf8"),
      p_query_params: {},
      p_content_type: "message/rfc822",
      p_ip: "192.0.2.10",
      p_received_at: new Date().toISOString(),
      p_body_raw: `\\x${raw.toString("hex")}`,
      p_kind: "email",
      p_email: { subject: "Caf\ufffd latin1" },
      p_dedupe_key: null,
      p_retry: false,
      p_size: null,
    });
    expect(error).toBeNull();
    expect((data as { status: string }).status).toBe("ok");

    const results = await searchRequestsForUser({ userId, slug, q: "latin1" });
    expect(results).toHaveLength(1);
    expect(results[0].bodyRaw).toBe(raw.toString("base64"));
  });

  it("lists only emails or only HTTP requests when asked", async () => {
    const { error } = await admin.rpc("capture_webhook", {
      p_slug: slug,
      p_method: "POST",
      p_path: "/hooks",
      p_headers: { "content-type": "application/json" },
      p_body: '{"ok":true}',
      p_query_params: {},
      p_content_type: "application/json",
      p_ip: "192.0.2.10",
      p_received_at: new Date().toISOString(),
    });
    expect(error).toBeNull();

    const all = await listRequestsForEndpointByUser({ userId, slug });
    const emails = await listRequestsForEndpointByUser({ userId, slug, kind: "email" });
    const http = await listRequestsForEndpointByUser({ userId, slug, kind: "http" });
    expect(emails!.length).toBeGreaterThan(0);
    expect(emails!.every((request) => request.kind === "email")).toBe(true);
    expect(http!.map((request) => request.path)).toEqual(["/hooks"]);
    expect(emails!.length + http!.length).toBe(all!.length);

    const page = await listPaginatedRequestsForEndpointByUser({ userId, slug, kind: "http" });
    expect(page!.items.map((request) => request.path)).toEqual(["/hooks"]);
  });
});
