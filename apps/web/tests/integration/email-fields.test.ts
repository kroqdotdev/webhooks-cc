import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { createDestination } from "@/lib/supabase/destinations";
import { runForwardingBatch } from "@/lib/forwarding/worker";
import { PATCH as patchEndpoint } from "@/app/api/endpoints/[slug]/route";
import { POST as previewFields } from "@/app/api/endpoints/[slug]/email-fields/preview/route";
import { GET as getRequest } from "@/app/api/requests/[id]/route";
import { POST as renderEmail } from "@/app/api/requests/[id]/render/route";

/**
 * Named email fields and the inbound provider shapes (migration 00064),
 * through the routes and the worker, against the local database. Runs in
 * the forwarding project (vitest.config.ts): its worker shares the queue.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
// capture_webhook() is the receiver's, not in the web app's types.
const receiver = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface TestUser {
  id: string;
  accessToken: string;
}

async function signedInUser(label: string): Promise<TestUser> {
  const email = `test-fields-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@webhooks-test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signIn = await anon.auth.signInWithPassword({ email, password: "TestPassword123!" });
  if (signIn.error) throw signIn.error;
  return { id: data.user!.id, accessToken: signIn.data.session!.access_token };
}

function routeRequest(path: string, bearer: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${bearer}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  return new Request(`https://webhooks.cc${path}`, { ...init, headers });
}

const RAW =
  "From: Acme Billing <billing@acme.example>\r\nTo: <ACME@mailhooks.cc>\r\nSubject: Invoice INV-2041\r\n\r\nPaid, thanks.\r\n\r\nOn Sat, Acme Billing wrote:\r\n> Total: 42.00 EUR\r\n";

let owner: TestUser;
let stranger: TestUser;
let endpointId = "";
let slug = "";
let server: Server;
let base = "";
const received: { headers: IncomingHttpHeaders; body: string }[] = [];

async function captureEmail(): Promise<string> {
  const address = `${slug}+inv@mailhooks.cc`;
  const { data, error } = await receiver.rpc("capture_webhook", {
    p_slug: slug,
    p_method: "EMAIL",
    p_path: address,
    p_headers: { from: "Acme Billing <billing@acme.example>", subject: "Invoice INV-2041" },
    p_body: RAW.replace("ACME", address),
    p_query_params: {},
    p_content_type: "message/rfc822",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
    p_body_raw: null,
    p_kind: "email",
    p_email: {
      subject: "Invoice INV-2041",
      from: [{ name: "Acme Billing", address: "billing@acme.example" }],
      to: [{ name: null, address }],
      tag: "inv",
      text: "Paid, thanks.\n\nOn Sat, Acme Billing wrote:\n> Total: 42.00 EUR\n",
    },
    p_dedupe_key: null,
    p_retry: false,
    p_size: null,
  });
  if (error) throw error;
  return (data as { request_id: string }).request_id;
}

beforeAll(async () => {
  owner = await signedInUser("owner");
  stranger = await signedInUser("stranger");
  const endpoint = await createEndpointForUser({ userId: owner.id, name: "Fields" });
  endpointId = endpoint.id;
  slug = endpoint.slug;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  server?.close();
  if (endpointId) {
    await admin
      .from("endpoint_destinations")
      .update({ enabled: false })
      .eq("endpoint_id", endpointId);
    await admin.from("requests").delete().eq("endpoint_id", endpointId);
    await admin.from("endpoints").update({ request_count: 0 }).eq("id", endpointId);
    await admin.from("endpoints").delete().eq("id", endpointId);
  }
  for (const user of [owner, stranger]) if (user?.id) await admin.auth.admin.deleteUser(user.id);
});

const FIELDS = [
  { name: "invoice", from: "subject", pattern: "(INV-\\d+)" },
  { name: "total", from: "text", pattern: "Total: ([\\d.]+)" },
];

describe("email fields", () => {
  let requestId = "";

  it("refuses a pattern RE2 cannot run, and saves a good list for the owner only", async () => {
    const bad = await patchEndpoint(
      routeRequest(`/api/endpoints/${slug}`, owner.accessToken, {
        method: "PATCH",
        body: JSON.stringify({ emailFields: [{ name: "a", from: "text", pattern: "(?<=x)y" }] }),
      }),
      { params: Promise.resolve({ slug }) }
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/^emailFields: field 1: pattern: /);

    const ok = await patchEndpoint(
      routeRequest(`/api/endpoints/${slug}`, owner.accessToken, {
        method: "PATCH",
        body: JSON.stringify({ emailFields: FIELDS }),
      }),
      { params: Promise.resolve({ slug }) }
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).emailFields).toEqual(FIELDS);

    const stranger403 = await patchEndpoint(
      routeRequest(`/api/endpoints/${slug}`, stranger.accessToken, {
        method: "PATCH",
        body: JSON.stringify({ emailFields: [] }),
      }),
      { params: Promise.resolve({ slug }) }
    );
    expect(stranger403.status).toBe(404);
  });

  it("previews unsaved fields on the newest email", async () => {
    requestId = await captureEmail();
    const response = await previewFields(
      routeRequest(`/api/endpoints/${slug}/email-fields/preview`, owner.accessToken, {
        method: "POST",
        body: JSON.stringify({
          emailFields: [...FIELDS, { name: "nope", from: "subject", pattern: "PO-\\d+" }],
        }),
      }),
      { params: Promise.resolve({ slug }) }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      problems: [],
      request: { id: requestId, subject: "Invoice INV-2041" },
      values: { invoice: "INV-2041", total: "42.00", nope: null },
    });
  });

  it("serves the values and the reply text with the email", async () => {
    const response = await getRequest(
      routeRequest(`/api/requests/${requestId}?extracts=true`, owner.accessToken),
      { params: Promise.resolve({ id: requestId }) }
    );
    const body = await response.json();
    expect(body.emailFields).toEqual({ invoice: "INV-2041", total: "42.00" });
    expect(body.replyText).toBe("Paid, thanks.");
  });

  it("renders the email as Postmark posts it, for the owner and not for others", async () => {
    const response = await renderEmail(
      routeRequest(`/api/requests/${requestId}/render`, owner.accessToken, {
        method: "POST",
        body: JSON.stringify({ format: "postmark" }),
      }),
      { params: Promise.resolve({ id: requestId }) }
    );
    expect(response.status).toBe(200);
    const rendered = await response.json();
    expect(rendered.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(rendered.body)).toMatchObject({
      Subject: "Invoice INV-2041",
      MailboxHash: "inv",
      StrippedTextReply: "Paid, thanks.",
    });

    const denied = await renderEmail(
      routeRequest(`/api/requests/${requestId}/render`, stranger.accessToken, {
        method: "POST",
        body: JSON.stringify({ format: "postmark" }),
      }),
      { params: Promise.resolve({ id: requestId }) }
    );
    expect(denied.status).toBe(404);
  });

  it("forwards in a provider's shape, filtered on a field", async () => {
    await createDestination(endpointId, {
      url: `${base}/inbound`,
      http: false,
      format: "cloudmailin",
      filter: {
        logic: "and",
        conditions: [{ field: "email_field", name: "total", op: "gt", value: "40" }],
      },
    });
    const id = await captureEmail();
    for (
      let i = 0;
      i < 40 && !received.some((r) => r.body.includes(id) || r.body.includes("reply_plain"));
      i++
    ) {
      await runForwardingBatch();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const got = received.find((r) => r.body.includes("reply_plain"));
    expect(got).toBeTruthy();
    expect(got!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(got!.body)).toMatchObject({
      plain: expect.stringContaining("Paid, thanks."),
      reply_plain: "Paid, thanks.",
      envelope: { to: `${slug}+inv@mailhooks.cc` },
    });
  });
});
