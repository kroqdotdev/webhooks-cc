import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser, createGuestEndpoint } from "@/lib/supabase/endpoints";

/**
 * The receiver's private mail API end to end: signed requests in, rows and
 * counters out. Needs the receiver running with its mail listener, which
 * `make dev-receiver` and `make dev` start on 127.0.0.1:3002.
 * Override the address with MAIL_INGEST_URL.
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

const ts = Date.now();
let counter = 0;
const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];
const createdEndpointIds: string[] = [];

async function signedPost(path: string, payload: unknown, secret = SECRET!) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.POST.${path}.`)
    .update(body)
    .digest("hex");
  return fetch(`${MAIL_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mail-timestamp": String(timestamp),
      "x-mail-signature": signature,
    },
    body,
  });
}

type CheckResult = { status: string; endpoint_id?: string };
type DeliverResult = {
  results: { recipient: string; status: string; request_id?: string }[];
};

async function check(address: string): Promise<CheckResult> {
  const res = await signedPost("/internal/mail/check", { address });
  expect(res.status).toBe(200);
  return (await res.json()) as CheckResult;
}

async function deliver(recipients: string[], raw: string, retry = false): Promise<DeliverResult> {
  const res = await signedPost("/internal/mail/deliver", {
    recipients,
    envelope_from: "bounce@sender.example",
    client_ip: "192.0.2.25",
    client_rdns: "mail.sender.example",
    helo: "mail.sender.example",
    tls: { version: "TLSv1.3", cipher: "TLS_AES_128_GCM_SHA256" },
    auth: { spf: "pass", dkim: [], dmarc: "none" },
    received_at: new Date().toISOString(),
    retry,
    raw: Buffer.from(raw, "utf8").toString("base64"),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as DeliverResult;
}

const statuses = (result: DeliverResult) => result.results.map((r) => r.status);

/** A message unique to this run and label; identical bytes for the same label. */
function message(label: string, body = "Your code is 424242.") {
  return (
    `From: Sender <sender@sender.example>\r\n` +
    `To: someone@mailhooks.cc\r\n` +
    `Subject: ${label}\r\n` +
    `Message-ID: <${label.replace(/\W/g, "")}-${ts}@sender.example>\r\n` +
    `\r\n${body}\r\n`
  );
}

async function createUser(): Promise<string> {
  counter += 1;
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-email-ingest-${counter}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  createdUserIds.push(data.user!.id);
  return data.user!.id;
}

async function createEndpoint(userId: string) {
  const endpoint = await createEndpointForUser({ userId, name: "ingest" });
  createdEndpointIds.push(endpoint.id);
  return endpoint;
}

async function createOwnedEndpoint() {
  const userId = await createUser();
  return { userId, endpoint: await createEndpoint(userId) };
}

async function getUser(userId: string) {
  const { data, error } = await admin
    .from("users")
    .select("requests_used, period_end")
    .eq("id", userId)
    .single();
  if (error) throw error;
  return data as { requests_used: number; period_end: string | null };
}

const requestsUsed = async (userId: string) => (await getUser(userId)).requests_used;

async function setUserQuota(userId: string, fields: Record<string, unknown>) {
  const { error } = await admin.from("users").update(fields).eq("id", userId);
  if (error) throw error;
}

/** The parts of the stored `email` document these tests read. */
type StoredEmail = {
  subject: string | null;
  tag: string | null;
  text: string;
  text_truncated: boolean;
  raw_truncated: boolean;
  auth: unknown;
  smtp: {
    client_ip: string;
    helo: string | null;
    envelope_from: string;
    envelope_to: string[];
    size: number;
  };
};

type Row = {
  id: string;
  kind: string;
  method: string;
  path: string;
  ip: string;
  body: string;
  content_type: string;
  size: number;
  team_id: string | null;
  email: StoredEmail;
};

async function rows(endpointId: string): Promise<Row[]> {
  const { data, error } = await admin
    .from("requests")
    .select("id, kind, method, path, ip, body, content_type, size, team_id, email")
    .eq("endpoint_id", endpointId);
  if (error) throw error;
  return (data ?? []) as Row[];
}

async function onlyRow(endpointId: string): Promise<Row> {
  const all = await rows(endpointId);
  expect(all).toHaveLength(1);
  return all[0];
}

beforeAll(async () => {
  let status = 0;
  try {
    status = (await fetch(`${MAIL_URL}/internal/mail/check`, { method: "POST" })).status;
  } catch {
    status = 0;
  }
  // An unsigned probe must be refused; anything else is not our listener.
  if (status !== 401) {
    throw new Error(
      `Receiver mail listener not found at ${MAIL_URL} (probe answered ${status || "nothing"}). ` +
        "Start the receiver with `make dev-receiver`, which enables it on 127.0.0.1:3002."
    );
  }
});

afterAll(async () => {
  if (createdEndpointIds.length > 0) {
    await admin.from("endpoints").update({ request_count: 0 }).in("id", createdEndpointIds);
    await admin.from("requests").delete().in("endpoint_id", createdEndpointIds);
    await admin.from("endpoint_daily_stats").delete().in("endpoint_id", createdEndpointIds);
    await admin.from("team_endpoints").delete().in("endpoint_id", createdEndpointIds);
    await admin.from("endpoints").delete().in("id", createdEndpointIds);
  }
  if (createdTeamIds.length > 0) {
    await admin.from("teams").delete().in("id", createdTeamIds);
  }
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
});

describe("mail ingest authentication", () => {
  it("rejects unsigned and wrongly signed requests", async () => {
    const unsigned = await fetch(`${MAIL_URL}/internal/mail/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "abc@mailhooks.cc" }),
    });
    expect(unsigned.status).toBe(401);

    const wrong = await signedPost(
      "/internal/mail/check",
      { address: "abc@mailhooks.cc" },
      "not-the-secret"
    );
    expect(wrong.status).toBe(401);
  });
});

describe("POST /internal/mail/check", () => {
  it("classifies recipients without side effects", async () => {
    const { userId, endpoint } = await createOwnedEndpoint();
    expect(await check(`${endpoint.slug}+anything@mailhooks.cc`)).toEqual({
      status: "ok",
      endpoint_id: endpoint.id,
    });
    expect(await check(`<${endpoint.slug.toUpperCase()}@MailHooks.cc>`)).toMatchObject({
      status: "ok",
    });
    // No Free period started, nothing billed.
    expect(await getUser(userId)).toEqual({ requests_used: 0, period_end: null });

    const guest = await createGuestEndpoint();
    createdEndpointIds.push(guest.id);
    expect(await check(`${guest.slug}@mailhooks.cc`)).toMatchObject({ status: "guest" });

    expect(await check(`missing${ts}@mailhooks.cc`)).toEqual({ status: "unknown" });
    expect(await check(`${endpoint.slug}@example.com`)).toEqual({ status: "relay_denied" });
    expect(await check(`"quoted"@mailhooks.cc`)).toEqual({ status: "invalid" });
  });

  it("reports expired and over-quota endpoints", async () => {
    const expired = await createOwnedEndpoint();
    const { error } = await admin
      .from("endpoints")
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", expired.endpoint.id);
    if (error) throw error;
    expect(await check(`${expired.endpoint.slug}@mailhooks.cc`)).toMatchObject({
      status: "expired",
    });

    const full = await createOwnedEndpoint();
    await setUserQuota(full.userId, {
      requests_used: 50,
      request_limit: 50,
      period_end: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(await check(`${full.endpoint.slug}@mailhooks.cc`)).toMatchObject({
      status: "over_quota",
    });
  });
});

describe("POST /internal/mail/deliver", () => {
  it("captures one request per endpoint and records the email", async () => {
    const { userId, endpoint } = await createOwnedEndpoint();
    const result = await deliver([`${endpoint.slug}+signup@mailhooks.cc`], message("Welcome"));

    expect(statuses(result)).toEqual(["captured"]);
    expect(await requestsUsed(userId)).toBe(1);

    const row = await onlyRow(endpoint.id);
    expect(row).toMatchObject({
      id: result.results[0].request_id,
      kind: "email",
      method: "EMAIL",
      path: `${endpoint.slug}+signup@mailhooks.cc`,
      ip: "192.0.2.25",
      content_type: "message/rfc822",
    });
    expect(row.body).toContain("Your code is 424242.");
    expect(row.email.subject).toBe("Welcome");
    expect(row.email.tag).toBe("signup");
    expect(row.email.raw_truncated).toBe(false);
    expect(row.email.smtp).toMatchObject({
      client_ip: "192.0.2.25",
      helo: "mail.sender.example",
      envelope_from: "bounce@sender.example",
      envelope_to: [`${endpoint.slug}+signup@mailhooks.cc`],
    });
    expect(row.email.auth).toEqual({ spf: "pass", dkim: [], dmarc: "none" });
  });

  it("never counts a sender retry twice", async () => {
    const { userId, endpoint } = await createOwnedEndpoint();
    const raw = message("Retry me");

    const first = await deliver([`${endpoint.slug}@mailhooks.cc`], raw);
    expect(statuses(first)).toEqual(["captured"]);
    const retry = await deliver([`${endpoint.slug}@mailhooks.cc`], raw, true);
    expect(retry.results[0]).toMatchObject({
      status: "duplicate",
      request_id: first.results[0].request_id,
    });

    expect(await requestsUsed(userId)).toBe(1);
    expect(await rows(endpoint.id)).toHaveLength(1);
  });

  it("captures concurrent retries of one message once", async () => {
    const { userId, endpoint } = await createOwnedEndpoint();
    const raw = message("Concurrent retries");
    const results = await Promise.all(
      [0, 1, 2].map(() => deliver([`${endpoint.slug}@mailhooks.cc`], raw, true))
    );
    expect(results.map((r) => r.results[0].status).sort()).toEqual([
      "captured",
      "duplicate",
      "duplicate",
    ]);
    expect(await requestsUsed(userId)).toBe(1);
    expect(await rows(endpoint.id)).toHaveLength(1);
  });

  it("captures the same message again when the sender sends it again on purpose", async () => {
    const { userId, endpoint } = await createOwnedEndpoint();
    const raw = message("Fixture replay");
    expect(statuses(await deliver([`${endpoint.slug}@mailhooks.cc`], raw))).toEqual(["captured"]);
    expect(statuses(await deliver([`${endpoint.slug}@mailhooks.cc`], raw))).toEqual(["captured"]);
    expect(await requestsUsed(userId)).toBe(2);
    expect(await rows(endpoint.id)).toHaveLength(2);
  });

  it("finishes a partly captured message on retry without billing twice", async () => {
    const a = await createOwnedEndpoint();
    const b = await createOwnedEndpoint();
    const raw = message("Partial");

    expect(statuses(await deliver([`${a.endpoint.slug}@mailhooks.cc`], raw))).toEqual(["captured"]);
    const retry = await deliver(
      [`${a.endpoint.slug}@mailhooks.cc`, `${b.endpoint.slug}@mailhooks.cc`],
      raw,
      true
    );
    expect(statuses(retry)).toEqual(["duplicate", "captured"]);
    expect(await requestsUsed(a.userId)).toBe(1);
    expect(await requestsUsed(b.userId)).toBe(1);
  });

  it("captures on retry when the first attempt was refused for quota", async () => {
    const { userId, endpoint } = await createOwnedEndpoint();
    await setUserQuota(userId, {
      requests_used: 50,
      request_limit: 50,
      period_end: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const raw = message("After quota");

    expect(statuses(await deliver([`${endpoint.slug}@mailhooks.cc`], raw))).toEqual(["over_quota"]);
    expect(await rows(endpoint.id)).toHaveLength(0);
    expect(await requestsUsed(userId)).toBe(50);

    await setUserQuota(userId, { requests_used: 0 });
    expect(statuses(await deliver([`${endpoint.slug}@mailhooks.cc`], raw, true))).toEqual([
      "captured",
    ]);
    expect(await requestsUsed(userId)).toBe(1);
  });

  it("captures once when one message names the same endpoint twice", async () => {
    const { userId, endpoint } = await createOwnedEndpoint();
    const result = await deliver(
      [`${endpoint.slug}+a@mailhooks.cc`, `${endpoint.slug}+b@mailhooks.cc`],
      message("Two tags")
    );
    expect(statuses(result)).toEqual(["captured", "captured"]);
    expect(result.results[0].request_id).toBe(result.results[1].request_id);
    expect(await requestsUsed(userId)).toBe(1);
    const row = await onlyRow(endpoint.id);
    expect(row.email.smtp.envelope_to).toEqual([
      `${endpoint.slug}+a@mailhooks.cc`,
      `${endpoint.slug}+b@mailhooks.cc`,
    ]);
  });

  it("bills two endpoints of one owner as two requests", async () => {
    const userId = await createUser();
    const a = await createEndpoint(userId);
    const b = await createEndpoint(userId);
    const result = await deliver(
      [`${a.slug}@mailhooks.cc`, `${b.slug}@mailhooks.cc`],
      message("One owner")
    );
    expect(statuses(result)).toEqual(["captured", "captured"]);
    expect(await requestsUsed(userId)).toBe(2);
    await onlyRow(a.id);
    await onlyRow(b.id);
  });

  it("bills each endpoint of a multi-recipient message to its own owner", async () => {
    const a = await createOwnedEndpoint();
    const b = await createOwnedEndpoint();
    const result = await deliver(
      [`${a.endpoint.slug}@mailhooks.cc`, `${b.endpoint.slug}@mailhooks.cc`],
      message("Both")
    );
    expect(statuses(result)).toEqual(["captured", "captured"]);
    expect(await requestsUsed(a.userId)).toBe(1);
    expect(await requestsUsed(b.userId)).toBe(1);
  });

  it("stores for one recipient and refuses the other when only one has quota", async () => {
    const ok = await createOwnedEndpoint();
    const full = await createOwnedEndpoint();
    await setUserQuota(full.userId, {
      requests_used: 50,
      request_limit: 50,
      period_end: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const result = await deliver(
      [`${full.endpoint.slug}@mailhooks.cc`, `${ok.endpoint.slug}@mailhooks.cc`],
      message("Mixed quota")
    );
    expect(statuses(result)).toEqual(["over_quota", "captured"]);
    expect(await requestsUsed(full.userId)).toBe(50);
    expect(await rows(full.endpoint.id)).toHaveLength(0);
    expect(await requestsUsed(ok.userId)).toBe(1);
  });

  it("bills a team-shared endpoint to the team", async () => {
    const userId = await createUser();
    const { data, error } = await admin.rpc("create_team_with_owner", {
      p_user_id: userId,
      p_name: `Ingest team ${ts}`,
    });
    if (error) throw error;
    const teamId = (data as { id: string }).id;
    createdTeamIds.push(teamId);
    const endpoint = await createEndpoint(userId);
    const { error: shareError } = await admin
      .from("team_endpoints")
      .insert({ team_id: teamId, endpoint_id: endpoint.id, shared_by: userId });
    if (shareError) throw shareError;
    const { error: activateError } = await admin
      .from("teams")
      .update({
        subscription_status: "active",
        seats: 1,
        request_limit: 100_000,
        requests_used: 0,
        period_start: new Date().toISOString(),
        period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        polar_subscription_id: `sub_test_${teamId.slice(0, 8)}`,
      })
      .eq("id", teamId);
    if (activateError) throw activateError;

    expect(statuses(await deliver([`${endpoint.slug}@mailhooks.cc`], message("Team")))).toEqual([
      "captured",
    ]);
    const { data: team } = await admin
      .from("teams")
      .select("requests_used")
      .eq("id", teamId)
      .single();
    expect((team as { requests_used: number }).requests_used).toBe(1);
    expect(await requestsUsed(userId)).toBe(0);
    expect((await onlyRow(endpoint.id)).team_id).toBe(teamId);
  });

  it("refuses guests, expired endpoints and unknown slugs without counting, in request order", async () => {
    const guest = await createGuestEndpoint();
    createdEndpointIds.push(guest.id);
    const expired = await createOwnedEndpoint();
    const { error } = await admin
      .from("endpoints")
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", expired.endpoint.id);
    if (error) throw error;

    const recipients = [
      "x@example.com",
      `${guest.slug}@mailhooks.cc`,
      `missing${ts}@mailhooks.cc`,
      `${expired.endpoint.slug}@mailhooks.cc`,
    ];
    const result = await deliver(recipients, message("Nope"));
    expect(result.results.map((r) => r.recipient)).toEqual(recipients);
    expect(statuses(result)).toEqual(["relay_denied", "guest", "unknown", "expired"]);
    expect(await rows(guest.id)).toHaveLength(0);
    expect(await rows(expired.endpoint.id)).toHaveLength(0);
    expect(await requestsUsed(expired.userId)).toBe(0);
  });

  it("keeps only the header block of a message over 1 MiB but records its real size", async () => {
    const { userId, endpoint } = await createOwnedEndpoint();
    const raw = message("Large", "x".repeat(1_200_000));
    const result = await deliver([`${endpoint.slug}@mailhooks.cc`], raw);
    expect(statuses(result)).toEqual(["captured"]);
    expect(await requestsUsed(userId)).toBe(1);

    const row = await onlyRow(endpoint.id);
    expect(row.email.raw_truncated).toBe(true);
    expect(row.email.smtp.size).toBe(Buffer.byteLength(raw));
    expect(row.size).toBe(Buffer.byteLength(raw));
    expect(row.body).toContain("Subject: Large");
    expect(row.body).not.toContain("xxxx");
    expect(row.email.text.length).toBeLessThanOrEqual(256 * 1024);
    expect(row.email.text_truncated).toBe(true);
  });
});
