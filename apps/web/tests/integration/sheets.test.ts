import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser, updateEndpointBySlugForUser } from "@/lib/supabase/endpoints";
import { createDestination } from "@/lib/supabase/destinations";
import { saveGoogleConnection, listGoogleConnections } from "@/lib/supabase/google-connections";
import { runForwardingBatch } from "@/lib/forwarding/worker";
import { authorizationUrl, googleConfig } from "@/lib/integrations/google";
import { GET as callbackRoute } from "@/app/api/integrations/google/callback/route";

/**
 * The Google Sheets destination (migration 00068) against a local fake of
 * Google's token and Sheets endpoints: rows are batched into one append per
 * destination, written as RAW text, and a revoked grant fails the delivery
 * for a retry. Runs in the forwarding group (it drives the worker).
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
const calls: { method: string; path: string; auth: string | undefined; body: string }[] = [];
const SHEET_ID = "a".repeat(44);
const BROKEN_SHEET_ID = "b".repeat(44);

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      calls.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/token") {
        const params = new URLSearchParams(body);
        if (params.get("refresh_token") === "revoked") {
          return res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
        }
        return res.writeHead(200).end(
          JSON.stringify({
            access_token: `at-${params.get("grant_type")}`,
            expires_in: 3600,
            refresh_token: "rt-from-code",
            scope: "openid email https://www.googleapis.com/auth/drive.file",
            id_token: idToken({ sub: "google-sub-1", email: "owner@acme.example" }),
          })
        );
      }
      if (req.url?.includes(BROKEN_SHEET_ID)) {
        return res.writeHead(403).end(JSON.stringify({ error: { message: "The caller does not have permission" } }));
      }
      const rows = req.url?.includes(":append") ? (JSON.parse(body).values as unknown[]).length : 0;
      res.writeHead(200).end(JSON.stringify({ updates: { updatedRows: rows } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.GOOGLE_OAUTH_CLIENT_ID = "client-test";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret-test";
  process.env.GOOGLE_OAUTH_TOKEN_URL = `${base}/token`;
  process.env.GOOGLE_SHEETS_API_URL = base;

  const { data, error } = await admin.auth.admin.createUser({
    email: `test-sheets-${Date.now()}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  userId = data.user!.id;
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

async function capture(slug: string, subject: string) {
  const { error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
    p_method: "EMAIL",
    p_path: `${slug}@mailhooks.cc`,
    p_headers: { subject },
    p_body: "raw",
    p_query_params: {},
    p_content_type: "message/rfc822",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
    p_kind: "email",
    p_email: { subject, text: "body", from: [{ name: null, address: "orders@acme.example" }] },
  });
  if (error) throw error;
}

async function drain(endpointId: string) {
  for (let i = 0; i < 10; i++) {
    await runForwardingBatch(16);
    const { data } = await admin
      .from("email_deliveries")
      .select("id")
      .eq("endpoint_id", endpointId)
      .eq("status", "pending")
      .lte("next_attempt_at", new Date().toISOString());
    if (!data || data.length === 0) return;
  }
}

describe("Google Sheets destination", () => {
  it("appends a batch of rows in one call, as text", async () => {
    const connection = await saveGoogleConnection(userId, {
      sub: "sub-a",
      email: "owner@acme.example",
      refreshToken: "rt-good",
      scopes: "drive.file",
    });
    const endpoint = await createEndpointForUser({ userId, name: "sheets" });
    endpointIds.push(endpoint.id);
    await updateEndpointBySlugForUser({
      userId,
      slug: endpoint.slug,
      emailFields: [{ name: "order", from: "subject", pattern: "Order #(\\d+)" }],
    });
    await createDestination(endpoint.id, {
      url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
      format: "sheets",
      email: true,
      http: false,
      config: {
        connectionId: connection.id,
        spreadsheetId: SHEET_ID,
        sheet: "Orders",
        rows: "email",
        columns: [
          { header: "Subject", value: "{{ subject }}" },
          { header: "Order", value: "{{ fields.order }}" },
          { header: "From", value: "{{ from.address }}" },
        ],
      },
    });
    await capture(endpoint.slug, "Order #1001");
    await capture(endpoint.slug, "Order #1002");
    await capture(endpoint.slug, '=HYPERLINK("https://evil.example","click")');
    const before = calls.length;
    await drain(endpoint.id);

    const appends = calls.slice(before).filter((call) => call.path.includes(":append"));
    expect(appends).toHaveLength(1);
    expect(appends[0].path).toContain(`/v4/spreadsheets/${SHEET_ID}/values/`);
    expect(decodeURIComponent(appends[0].path)).toContain("'Orders'!A1:append");
    expect(appends[0].path).toContain("valueInputOption=RAW");
    expect(appends[0].auth).toBe("Bearer at-refresh_token");
    expect(JSON.parse(appends[0].body).values).toEqual([
      ["Order #1001", "1001", "orders@acme.example"],
      ["Order #1002", "1002", "orders@acme.example"],
      ['=HYPERLINK("https://evil.example","click")', "", "orders@acme.example"],
    ]);
    const { data } = await admin
      .from("email_deliveries")
      .select("status, last_status, format")
      .eq("endpoint_id", endpoint.id);
    expect(data?.every((row) => row.status === "succeeded" && row.format === "sheets")).toBe(true);
  });

  it("keeps deliveries for a retry when Google refuses", async () => {
    const revoked = await saveGoogleConnection(userId, {
      sub: "sub-b",
      email: null,
      refreshToken: "revoked",
      scopes: "drive.file",
    });
    const endpoint = await createEndpointForUser({ userId, name: "sheets revoked" });
    endpointIds.push(endpoint.id);
    await createDestination(endpoint.id, {
      url: `https://docs.google.com/spreadsheets/d/${BROKEN_SHEET_ID}/edit`,
      format: "sheets",
      email: true,
      http: false,
      config: {
        connectionId: revoked.id,
        spreadsheetId: BROKEN_SHEET_ID,
        sheet: "Sheet1",
        rows: "email",
        columns: [{ header: "Subject", value: "{{ subject }}" }],
      },
    });
    await capture(endpoint.slug, "Hello");
    await runForwardingBatch(16);
    const { data } = await admin
      .from("email_deliveries")
      .select("status, last_error")
      .eq("endpoint_id", endpoint.id)
      .single();
    expect(data?.status).toBe("pending");
    expect(data?.last_error).toContain("Connect the account again");
  });
});

describe("connecting a Google account", () => {
  it("returns from consent with a stored connection", async () => {
    const config = googleConfig()!;
    const url = new URL(authorizationUrl(config, userId, "/dashboard?endpoint=x"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(
      "openid email https://www.googleapis.com/auth/drive.file"
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    const state = url.searchParams.get("state")!;

    const response = await callbackRoute(
      new Request(`http://localhost:3000/api/integrations/google/callback?code=abc&state=${state}`)
    );
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/dashboard");
    expect(location.searchParams.get("endpoint")).toBe("x");
    expect(location.searchParams.get("google")).toBe("connected");
    const tokenCall = calls.filter((call) => call.path === "/token").at(-1)!;
    expect(new URLSearchParams(tokenCall.body).get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await listGoogleConnections(userId)).map((c) => c.email)).toContain(
      "owner@acme.example"
    );

    // A forged or tampered state goes nowhere.
    const middle = Math.floor(state.length / 2);
    const tampered =
      state.slice(0, middle) + (state[middle] === "A" ? "B" : "A") + state.slice(middle + 1);
    const forged = await callbackRoute(
      new Request(`http://localhost:3000/api/integrations/google/callback?code=abc&state=${tampered}`)
    );
    expect(new URL(forged.headers.get("location")!).searchParams.get("google")).toBe("expired");
  });
});
