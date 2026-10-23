import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";
import { hashApiKey } from "@/lib/supabase/api-keys";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { getSharedRequest } from "@/lib/supabase/request-shares";
import { REDACTED } from "@/lib/request-share";
import {
  GET as listSharesRoute,
  POST as createShareRoute,
} from "@/app/api/requests/[id]/shares/route";
import { DELETE as revokeShareRoute } from "@/app/api/request-shares/[id]/route";
import { GET as listAllSharesRoute } from "@/app/api/request-shares/route";
import { getRequestByIdForUser } from "@/lib/supabase/requests";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const TEST_PASSWORD = "TestPassword123!";

if (!SERVICE_ROLE_KEY || !ANON_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY and an anon key are required for integration tests");
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface TestUser {
  id: string;
  accessToken: string;
}

async function createSignedInUser(label: string): Promise<TestUser> {
  const email = `test-shares-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@webhooks-test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signIn = await anon.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (signIn.error) throw signIn.error;
  return { id: data.user!.id, accessToken: signIn.data.session!.access_token };
}

function routeRequest(path: string, bearer: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${bearer}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  return new Request(`https://webhooks.cc${path}`, { ...init, headers });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("request share links", () => {
  let owner: TestUser;
  let stranger: TestUser;
  let endpointId = "";
  let requestId = "";

  async function share(bearer: string, body: unknown, id = requestId) {
    return createShareRoute(
      routeRequest(`/api/requests/${id}/shares`, bearer, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      params(id)
    );
  }

  beforeAll(async () => {
    owner = await createSignedInUser("owner");
    stranger = await createSignedInUser("stranger");
    const endpoint = await createEndpointForUser({ userId: owner.id, name: "Share Endpoint" });
    endpointId = endpoint.id;
    const { data, error } = await admin
      .from("requests")
      .insert({
        endpoint_id: endpointId,
        user_id: owner.id,
        method: "POST",
        path: "/hooks/stripe",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk_test_hidden",
          "stripe-signature": "t=1,v1=abc",
        },
        body: '{"type":"invoice.paid","id":"evt_1"}',
        query_params: { token: "abc", page: "1" },
        content_type: "application/json",
        ip: "203.0.113.7",
        size: 36,
        received_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) throw error;
    requestId = data.id;
  });

  afterAll(async () => {
    for (const user of [owner, stranger]) {
      if (user?.id) await admin.auth.admin.deleteUser(user.id);
    }
  });

  it("publishes a redacted snapshot the public page can read", async () => {
    const response = await share(owner.accessToken, { expiresInDays: 7, hideSensitive: true });
    expect(response.status).toBe(200);
    const link = (await response.json()) as { id: string; token: string; expiresAt: number };
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(link.expiresAt - Date.now()).toBeGreaterThan(6.9 * 86_400_000);

    const shared = await getSharedRequest(link.token);
    expect(shared?.snapshot).toMatchObject({
      method: "POST",
      path: "/hooks/stripe",
      body: '{"type":"invoice.paid","id":"evt_1"}',
      redactedHeaders: ["authorization", "stripe-signature"],
      redactedQuery: ["token"],
    });
    expect(shared?.snapshot.headers.authorization).toBe(REDACTED);
    expect(JSON.stringify(shared)).not.toContain("sk_test_hidden");
    expect(JSON.stringify(shared)).not.toContain("203.0.113.7");

    const listed = await listSharesRoute(
      routeRequest(`/api/requests/${requestId}/shares`, owner.accessToken),
      params(requestId)
    );
    expect(((await listed.json()) as { id: string }[]).map((entry) => entry.id)).toContain(link.id);

    const { data: audit } = await admin
      .from("audit_events")
      .select("action, outcome, target_id")
      .eq("actor_user_id", owner.id)
      .eq("action", "request.share_created");
    expect(audit).toContainEqual({
      action: "request.share_created",
      outcome: "ok",
      target_id: link.id,
    });
  });

  it("keeps signatures when asked, but never credentials", async () => {
    const response = await share(owner.accessToken, { expiresInDays: 1, hideSensitive: false });
    const link = (await response.json()) as { token: string };
    const shared = await getSharedRequest(link.token);
    expect(shared?.snapshot.headers["stripe-signature"]).toBe("t=1,v1=abc");
    expect(shared?.snapshot.headers.authorization).toBe(REDACTED);
  });

  it("refuses strangers, API keys and odd lifetimes", async () => {
    expect((await share(stranger.accessToken, { expiresInDays: 7 })).status).toBe(404);
    expect((await share(owner.accessToken, { expiresInDays: 365 })).status).toBe(400);
    expect((await share(owner.accessToken, { expiresInDays: 7 }, "not-a-uuid")).status).toBe(404);

    const apiKey = `whcc_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const { error } = await admin.from("api_keys").insert({
      user_id: owner.id,
      key_hash: hashApiKey(apiKey),
      key_prefix: apiKey.slice(0, 12),
      name: "share test key",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(error).toBeNull();
    const withKey = await share(apiKey, { expiresInDays: 7 });
    expect(withKey.status).toBeGreaterThanOrEqual(401);
    expect(withKey.status).toBeLessThan(404);
  });

  it("lets only the endpoint's owner share, not a team member who can read it", async () => {
    const { data: team, error: teamError } = await admin.rpc("create_team_with_owner", {
      p_user_id: owner.id,
      p_name: `Share test ${Date.now()}`,
    });
    if (teamError) throw teamError;
    const teamId = (team as { id: string }).id;
    try {
      const { error: activateError } = await admin
        .from("teams")
        .update({
          subscription_status: "active",
          seats: 2,
          request_limit: 200_000,
          requests_used: 0,
          period_start: new Date().toISOString(),
          period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          polar_subscription_id: `sub_share_test_${Date.now()}`,
        })
        .eq("id", teamId);
      expect(activateError).toBeNull();
      expect(
        (
          await admin
            .from("team_members")
            .insert({ team_id: teamId, user_id: stranger.id, role: "member" })
        ).error
      ).toBeNull();
      expect(
        (
          await admin
            .from("team_endpoints")
            .insert({ team_id: teamId, endpoint_id: endpointId, shared_by: owner.id })
        ).error
      ).toBeNull();

      expect(await getRequestByIdForUser(stranger.id, requestId)).not.toBeNull();
      const refused = await share(stranger.accessToken, { expiresInDays: 7 });
      expect(refused.status).toBe(403);
    } finally {
      await admin.from("team_endpoints").delete().eq("team_id", teamId);
      await admin.from("teams").delete().eq("id", teamId);
    }
  });

  it("lists every live link of the account", async () => {
    const response = await listAllSharesRoute(
      routeRequest("/api/request-shares", owner.accessToken)
    );
    expect(response.status).toBe(200);
    const links = (await response.json()) as { path: string; endpointSlug: string | null }[];
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toMatchObject({ path: "/hooks/stripe" });
    expect(links[0].endpointSlug).toEqual(expect.any(String));

    const strangers = await listAllSharesRoute(
      routeRequest("/api/request-shares", stranger.accessToken)
    );
    expect(await strangers.json()).toEqual([]);
  });

  it("outlives the request but not a revoke", async () => {
    const response = await share(owner.accessToken, { expiresInDays: 30, hideSensitive: true });
    const link = (await response.json()) as { id: string; token: string };

    await admin.from("requests").delete().eq("id", requestId);
    expect((await getSharedRequest(link.token))?.snapshot.path).toBe("/hooks/stripe");

    const strangerRevoke = await revokeShareRoute(
      routeRequest(`/api/request-shares/${link.id}`, stranger.accessToken, { method: "DELETE" }),
      params(link.id)
    );
    expect(strangerRevoke.status).toBe(404);

    const revoke = await revokeShareRoute(
      routeRequest(`/api/request-shares/${link.id}`, owner.accessToken, { method: "DELETE" }),
      params(link.id)
    );
    expect(revoke.status).toBe(204);
    expect(await getSharedRequest(link.token)).toBeNull();
  });

  it("hides expired links and cleans them up", async () => {
    const { data, error } = await admin
      .from("request_shares")
      .insert({
        token: `expired${Math.random().toString(36).slice(2)}0000000000000000`.slice(0, 24),
        user_id: owner.id,
        endpoint_id: endpointId,
        snapshot: { v: 1 },
        created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        expires_at: new Date(Date.now() - 86_400_000).toISOString(),
      })
      .select("id, token")
      .single();
    expect(error).toBeNull();
    expect(await getSharedRequest(data!.token)).toBeNull();

    const { error: cleanupError } = await admin.rpc("cleanup_expired_request_shares");
    expect(cleanupError).toBeNull();
    const { data: left } = await admin.from("request_shares").select("id").eq("id", data!.id);
    expect(left).toEqual([]);
  });

  it("goes away with its endpoint", async () => {
    const { count: before } = await admin
      .from("request_shares")
      .select("id", { count: "exact", head: true })
      .eq("endpoint_id", endpointId);
    expect(before).toBeGreaterThan(0);

    await admin.from("endpoints").delete().eq("id", endpointId);
    const { count: after } = await admin
      .from("request_shares")
      .select("id", { count: "exact", head: true })
      .eq("endpoint_id", endpointId);
    expect(after).toBe(0);
  });
});
