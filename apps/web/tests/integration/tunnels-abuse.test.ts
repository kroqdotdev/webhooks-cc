import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

/*
 * Reports of shared previews and what staff do about them: the public report
 * form (/api/report), the operations center's sharing routes
 * (/api/ops/sharing/*), statements of reasons and decisions by email. A small
 * HTTP server stands in for the edge's control port. Staff sign-in (a session
 * that passed two-factor) is stood in for: the routes admit the user id in
 * x-test-staff, and everything after that is real.
 */

const EDGE_SECRET = "edge-secret-for-tests-0123456789abcdef";
process.env.EDGE_SECRET = EDGE_SECRET;
process.env.SHARE_PREVIEW_ORIGIN = "http://sharehooks.localhost:4000";
// The browser check is unit-tested (lib/turnstile.test.ts); here it is off.
delete process.env.TURNSTILE_SITE_KEY;
delete process.env.TURNSTILE_SECRET_KEY;

vi.mock("@/lib/staff", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/staff")>();
  return {
    ...real,
    authenticateStaffRequest: async (request: Request) => {
      const id = request.headers.get("x-test-staff");
      return id
        ? { success: true, userId: id }
        : { success: false, response: Response.json({ error: "Not found" }, { status: 404 }) };
    },
  };
});

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Handler = (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Route = { POST?: Handler; GET?: Handler; DELETE?: Handler };

let edgeCalls: { path: string; body: unknown }[] = [];
let fakeEdge: Server;
let routes: Record<string, Route>;
let hashApiKey: (key: string) => string;
let lastMessage: (email: string) => { subject: string; text: string } | null;

const ts = Date.now();
let counter = 0;
const createdUserIds: string[] = [];
let staffId: string;

async function createUser(fields: Record<string, unknown> = {}) {
  counter += 1;
  const email = `test-tunnels-abuse-${counter}-${ts}@webhooks-test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  const id = data.user!.id;
  createdUserIds.push(id);
  if (Object.keys(fields).length > 0) {
    const { error: updateError } = await admin.from("users").update(fields).eq("id", id);
    if (updateError) throw updateError;
  }
  const key = `whcc_abuse_${ts}_${counter}_${Math.random().toString(36).slice(2, 10)}`;
  const { error: keyError } = await admin.from("api_keys").insert({
    user_id: id,
    key_hash: hashApiKey(key),
    key_prefix: key.slice(0, 12),
    name: "abuse test key",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
  if (keyError) throw keyError;
  return { id, key, email };
}

async function open(key: string, extra: Record<string, unknown> = {}) {
  const res = await routes.open.POST!(
    new Request("http://localhost/api/edge/open", {
      method: "POST",
      headers: { authorization: `Bearer ${EDGE_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({
        apiKey: key,
        client: "test-laptop, Linux",
        instance: `run-${Math.random().toString(36).slice(2)}`,
        address: "192.0.2.10",
        ...extra,
      }),
    }),
    { params: Promise.resolve({}) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let ipCounter = 0;
async function report(body: Record<string, unknown>, ip?: string) {
  ipCounter += 1;
  const res = await routes.report.POST!(
    new Request("http://localhost/api/report", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip ?? `198.51.100.${ipCounter}`,
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function ops(
  route: string,
  method: "GET" | "POST" | "DELETE",
  opts: {
    body?: unknown;
    params?: Record<string, string>;
    url?: string;
    staff?: string | null;
  } = {}
) {
  const staff = opts.staff === undefined ? staffId : opts.staff;
  const res = await routes[route][method]!(
    new Request(opts.url ?? `http://localhost/api/ops/sharing`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(staff ? { "x-test-staff": staff } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    { params: Promise.resolve(opts.params ?? {}) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function shareRow(id: string) {
  const { data, error } = await admin.from("tunnel_shares").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

async function reportRow(id: string) {
  const { data, error } = await admin.from("abuse_reports").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

async function latestReportFor(name: string) {
  const { data, error } = await admin
    .from("abuse_reports")
    .select("*")
    .eq("name", name)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (error) throw error;
  return data;
}

const goodReport = (url: string, email: string) => ({
  url,
  kind: "phishing",
  details: "A fake bank sign-in page.",
  name: "Ada Reporter",
  email,
  agree: true,
});

beforeAll(async () => {
  fakeEdge = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      edgeCalls.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : null });
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => fakeEdge.listen(0, "127.0.0.1", resolve));
  process.env.EDGE_URL = `http://127.0.0.1:${(fakeEdge.address() as AddressInfo).port}`;

  ({ hashApiKey } = await import("@/lib/supabase/api-keys"));
  ({ getLastMessageForEmail: lastMessage } = await import("@/lib/email/dev-transport"));
  routes = {
    open: await import("@/app/api/edge/open/route"),
    report: await import("@/app/api/report/route"),
    reports: await import("@/app/api/ops/sharing/reports/route"),
    "reports/id": await import("@/app/api/ops/sharing/reports/[id]/route"),
    shares: await import("@/app/api/ops/sharing/shares/route"),
    "shares/stop": await import("@/app/api/ops/sharing/shares/[id]/stop/route"),
    accounts: await import("@/app/api/ops/sharing/accounts/[id]/route"),
    blocks: await import("@/app/api/ops/sharing/blocks/route"),
  } as unknown as Record<string, Route>;

  staffId = (await createUser()).id;
  const { error } = await admin.from("staff").insert({ user_id: staffId });
  if (error) throw error;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fakeEdge.close(() => resolve()));
  await admin.from("staff").delete().eq("user_id", staffId);
  await admin.from("abuse_reports").delete().in("user_id", createdUserIds);
  // Reports of names nobody ran (the anonymous and rate-limit ones).
  await admin.from("abuse_reports").delete().like("url", `%${ts}%`);
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

describe("the public report form", () => {
  it("takes a report of a live preview and names the run and account behind it", async () => {
    const owner = await createUser({ plan: "pro" });
    const opened = await open(owner.key);
    expect(opened.status).toBe(200);
    const url = `${String(opened.body.url)}/login`;
    const reporterEmail = `reporter-${ts}@webhooks-test.local`;

    const sent = await report(goodReport(url, reporterEmail));
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ ok: true, receiptTo: reporterEmail });

    const row = await latestReportFor(String(opened.body.name));
    expect(row).toMatchObject({
      source: "form",
      kind: "phishing",
      url,
      user_id: owner.id,
      share_id: opened.body.shareId,
      reporter_name: "Ada Reporter",
      reporter_email: reporterEmail,
      good_faith: true,
      status: "open",
    });
    const receipt = lastMessage(reporterEmail);
    expect(receipt?.subject).toBe("We got your report");
    // The reporter is told the checked address, never what they typed.
    expect(receipt?.text).toContain(String(opened.body.url));
    expect(receipt?.text).not.toContain("/login");
  });

  it("refuses addresses that are not previews and incomplete reports", async () => {
    const outside = await report(goodReport("https://example.com/", "a@webhooks-test.local"));
    expect(outside.status).toBe(400);
    expect(outside.body.error).toMatch(/isn't a preview/);

    const url = "http://acme-demo.sharehooks.localhost:4000/";
    expect(
      (await report({ ...goodReport(url, "a@webhooks-test.local"), details: "" })).status
    ).toBe(400);
    expect(
      (await report({ ...goodReport(url, "a@webhooks-test.local"), agree: false })).status
    ).toBe(400);
    expect(
      (await report({ ...goodReport(url, "a@webhooks-test.local"), kind: "spam!" })).status
    ).toBe(400);
  });

  it("takes child sexual abuse reports anonymously", async () => {
    const name = `anon-${ts}`;
    const sent = await report({
      url: `http://${name}.sharehooks.localhost:4000/`,
      kind: "csam",
      details: "",
      name: "",
      email: "",
      agree: true,
    });
    expect(sent.status).toBe(200);
    expect(sent.body.receiptTo).toBeNull();
    const row = await latestReportFor(name);
    expect(row).toMatchObject({ kind: "csam", reporter_email: null, user_id: null });
  });

  it("takes 5 reports an hour from one address", async () => {
    const ip = `203.0.113.${(ts % 200) + 20}`;
    const url = `http://limited-${ts}.sharehooks.localhost:4000/`;
    for (let i = 0; i < 5; i++)
      expect((await report(goodReport(url, `r${i}-${ts}@webhooks-test.local`), ip)).status).toBe(
        200
      );
    const sixth = await report(goodReport(url, `r6-${ts}@webhooks-test.local`), ip);
    expect(sixth.status).toBe(429);
  });
});

describe("staff on reports", () => {
  it("answer 404 to anyone but staff", async () => {
    expect((await ops("reports", "GET", { staff: null })).status).toBe(404);
  });

  it("block the reported name: the run stops, the account gets a statement of reasons", async () => {
    const owner = await createUser({ plan: "pro" });
    const opened = await open(owner.key);
    const name = String(opened.body.name);
    await report(goodReport(`${String(opened.body.url)}/`, `rb-${ts}@webhooks-test.local`));
    const row = await latestReportFor(name);

    const listed = await ops("reports", "GET", { url: "http://localhost/api/ops/sharing/reports" });
    expect(listed.status).toBe(200);
    const mine = (listed.body.reports as { id: string; owner: { id: string } | null }[]).find(
      (r) => r.id === row.id
    );
    expect(mine?.owner?.id).toBe(owner.id);

    edgeCalls = [];
    const blocked = await ops("reports/id", "POST", {
      params: { id: row.id },
      body: { action: "block_name" },
    });
    expect(blocked.status).toBe(200);
    expect(blocked.body.message).toMatch(/Stopped 1 preview/);
    const { data: block } = await admin
      .from("tunnel_blocked_names")
      .select("name, blocked_by")
      .eq("name", name)
      .single();
    expect(block).toEqual({ name, blocked_by: staffId });
    expect((await shareRow(String(opened.body.shareId))).end_reason).toBe("name blocked");
    expect(edgeCalls.some((c) => c.path === "/close")).toBe(true);
    expect(lastMessage(owner.email)?.subject).toBe("We took your preview down");
    expect((await reportRow(row.id)).statement_sent_at).not.toBeNull();

    // The name can no longer be shared.
    const again = await open(owner.key, { name });
    expect(again.status).toBe(403);
    await admin.from("tunnel_blocked_names").delete().eq("name", name);
  });

  it("suspend sharing on the account behind a report only when confirmed", async () => {
    const owner = await createUser({ plan: "pro" });
    const opened = await open(owner.key);
    await report(goodReport(`${String(opened.body.url)}/`, `rs-${ts}@webhooks-test.local`));
    const row = await latestReportFor(String(opened.body.name));

    const unconfirmed = await ops("reports/id", "POST", {
      params: { id: row.id },
      body: { action: "suspend" },
    });
    expect(unconfirmed.status).toBe(400);

    const suspended = await ops("reports/id", "POST", {
      params: { id: row.id },
      body: { action: "suspend", confirm: true },
    });
    expect(suspended.status).toBe(200);
    expect((await shareRow(String(opened.body.shareId))).end_reason).toBe("sharing suspended");
    const refused = await open(owner.key);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/suspended/);

    const restored = await ops("accounts", "POST", {
      params: { id: owner.id },
      body: { action: "restore" },
    });
    expect(restored.status).toBe(200);
    expect((await open(owner.key)).status).toBe(200);
  });

  it("never sends a statement of reasons for child sexual abuse", async () => {
    const owner = await createUser({ plan: "pro" });
    const opened = await open(owner.key);
    const before = lastMessage(owner.email);
    const recorded = await ops("reports", "POST", {
      body: { url: `${String(opened.body.url)}/image.jpg` },
    });
    expect(recorded.status).toBe(200);
    const row = await reportRow(String(recorded.body.id));
    expect(row).toMatchObject({ kind: "csam", source: "flag", user_id: owner.id });

    const blocked = await ops("reports/id", "POST", {
      params: { id: row.id },
      body: { action: "block_name" },
    });
    expect(blocked.status).toBe(200);
    expect(lastMessage(owner.email)).toEqual(before);
    expect((await reportRow(row.id)).statement_sent_at).toBeNull();
    await admin.from("tunnel_blocked_names").delete().eq("name", String(opened.body.name));
  });

  it("resolve a report once and tell the reporter", async () => {
    const owner = await createUser({ plan: "pro" });
    const opened = await open(owner.key);
    const reporterEmail = `rr-${ts}@webhooks-test.local`;
    await report(goodReport(`${String(opened.body.url)}/`, reporterEmail));
    const row = await latestReportFor(String(opened.body.name));

    expect(
      (
        await ops("reports/id", "POST", {
          params: { id: row.id },
          body: { action: "resolve", outcome: "kept" },
        })
      ).status
    ).toBe(400);
    const resolved = await ops("reports/id", "POST", {
      params: { id: row.id },
      body: { action: "resolve", outcome: "kept", note: "A real bank's own test page." },
    });
    expect(resolved.status).toBe(200);
    const after = await reportRow(row.id);
    expect(after).toMatchObject({
      status: "resolved",
      outcome: "kept: A real bank's own test page.",
      resolved_by: staffId,
    });
    expect(lastMessage(reporterEmail)?.subject).toBe("About your report");
    expect(lastMessage(reporterEmail)?.text).toMatch(/did not find a reason/);

    const twice = await ops("reports/id", "POST", {
      params: { id: row.id },
      body: { action: "resolve", outcome: "removed", note: "Again." },
    });
    expect(twice.status).toBe(409);
  });
});

describe("staff on shares, blocks and accounts", () => {
  it("list every live run and stop one", async () => {
    const owner = await createUser({ plan: "pro" });
    const opened = await open(owner.key);
    const listed = await ops("shares", "GET");
    expect(listed.status).toBe(200);
    const found = (listed.body.shares as { id: string; user: { id: string } }[]).find(
      (s) => s.id === opened.body.shareId
    );
    expect(found?.user.id).toBe(owner.id);

    const stopped = await ops("shares/stop", "POST", {
      params: { id: String(opened.body.shareId) },
    });
    expect(stopped.status).toBe(200);
    expect((await shareRow(String(opened.body.shareId))).end_reason).toBe("stopped by webhooks.cc");
  });

  it("block and unblock words and names", async () => {
    const word = `zq${ts % 100000}`;
    expect(
      (await ops("blocks", "POST", { body: { kind: "word", value: word, reason: "x" } })).status
    ).toBe(400);
    expect(
      (await ops("blocks", "POST", { body: { kind: "word", value: "a-b", reason: "lure" } })).status
    ).toBe(400);
    const added = await ops("blocks", "POST", {
      body: { kind: "word", value: word, reason: "lure word" },
    });
    expect(added.status).toBe(200);

    // A name with the word can no longer be reserved.
    const owner = await createUser({ plan: "pro" });
    const refused = await open(owner.key, { name: `my-${word}-demo` });
    expect(refused.status).toBe(403);

    const lists = await ops("blocks", "GET");
    expect((lists.body.words as { word: string }[]).some((w) => w.word === word)).toBe(true);
    expect((await ops("blocks", "DELETE", { body: { kind: "word", value: word } })).status).toBe(
      200
    );
    expect((await ops("blocks", "DELETE", { body: { kind: "word", value: word } })).status).toBe(
      404
    );
  });

  it("lift the new-account notice for a new paid account", async () => {
    const owner = await createUser({ plan: "pro" });
    await admin.from("users").update({ paid_since: new Date().toISOString() }).eq("id", owner.id);
    expect((await open(owner.key)).body.notice).toBe(true);

    const lifted = await ops("accounts", "POST", {
      params: { id: owner.id },
      body: { action: "lift_notice" },
    });
    expect(lifted.status).toBe(200);
    expect((lifted.body.account as { noticeLifted: boolean }).noticeLifted).toBe(true);
    expect((await open(owner.key)).body.notice).toBe(false);
  });

  it("never suspend a staff account from its account page either", async () => {
    const refused = await ops("accounts", "POST", {
      params: { id: staffId },
      body: { action: "suspend", confirm: true },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/Staff accounts/);
    const { data } = await admin
      .from("users")
      .select("tunnels_suspended")
      .eq("id", staffId)
      .single();
    expect(data?.tunnels_suspended).toBe(false);
  });
});
