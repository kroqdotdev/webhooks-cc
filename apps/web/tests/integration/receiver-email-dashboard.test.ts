import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { extractFromEmail } from "@/lib/email-extract";
import {
  createEndpointForUser,
  getEndpointBySlugForUser,
  updateEndpointBySlugForUser,
} from "@/lib/supabase/endpoints";
import { listRequestsForEndpointByUser } from "@/lib/supabase/requests";
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
    expect(request.email?.smtp).toMatchObject({ envelopeFrom: "test@webhooks.cc" });
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
});
