import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser } from "@/lib/supabase/endpoints";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Enough parallel calls to overlap inside the database through PostgREST.
const CONCURRENT = 25;

const createdUserIds: string[] = [];
const createdEndpointIds: string[] = [];

async function createFreeUser(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-capture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  createdUserIds.push(data.user!.id);
  return data.user!.id;
}

/** All 10 arguments named: the dev database still has a legacy 9-argument overload. */
async function capture(slug: string) {
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
    p_method: "POST",
    p_path: "/",
    p_headers: { "content-type": "application/json" },
    p_body: '{"n":1}',
    p_query_params: {},
    p_content_type: "application/json",
    p_ip: "127.0.0.1",
    p_received_at: new Date().toISOString(),
    p_body_raw: null,
  });
  if (error) throw error;
  return data as { status: string; billing_key?: string };
}

/** What the receiver asks before the first capture of an uncached slug. */
async function billingKey(slug: string) {
  const { data, error } = await admin.rpc(
    "capture_billing_key" as never,
    { p_slug: slug } as never
  );
  if (error) throw error;
  return data as string | null;
}

afterAll(async () => {
  if (createdEndpointIds.length > 0) {
    await admin.from("endpoints").delete().in("id", createdEndpointIds);
  }
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
});

describe("capture_webhook under concurrency", () => {
  it("lets concurrent first captures of a free account all through", async () => {
    const userId = await createFreeUser();
    const endpoint = await createEndpointForUser({ userId, name: "Race endpoint" });
    createdEndpointIds.push(endpoint.id);

    const { data: before } = await admin
      .from("users")
      .select("period_end")
      .eq("id", userId)
      .single();
    expect(before!.period_end).toBeNull();

    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, () => capture(endpoint.slug))
    );
    expect(results.map((result) => result.status)).toEqual(Array(CONCURRENT).fill("ok"));

    const { data: after } = await admin
      .from("users")
      .select("requests_used, period_end")
      .eq("id", userId)
      .single();
    expect(after!.requests_used).toBe(CONCURRENT);
    expect(after!.period_end).not.toBeNull();
  });

  it("lets concurrent captures through when a free period rolls over", async () => {
    const userId = await createFreeUser();
    const endpoint = await createEndpointForUser({ userId, name: "Rollover endpoint" });
    createdEndpointIds.push(endpoint.id);

    const { data: profile } = await admin
      .from("users")
      .select("request_limit")
      .eq("id", userId)
      .single();
    // An exhausted period that has just ended.
    await admin
      .from("users")
      .update({
        requests_used: profile!.request_limit,
        period_start: new Date(Date.now() - 25 * 3_600_000).toISOString(),
        period_end: new Date(Date.now() - 1000).toISOString(),
      })
      .eq("id", userId);

    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, () => capture(endpoint.slug))
    );
    expect(results.map((result) => result.status)).toEqual(Array(CONCURRENT).fill("ok"));

    const { data: after } = await admin
      .from("users")
      .select("requests_used")
      .eq("id", userId)
      .single();
    expect(after!.requests_used).toBe(CONCURRENT);
  });

  it("returns the billing key the receiver caps concurrency on", async () => {
    const userId = await createFreeUser();
    const endpoint = await createEndpointForUser({ userId, name: "Key endpoint" });
    createdEndpointIds.push(endpoint.id);
    await expect(billingKey(endpoint.slug)).resolves.toBe(`user:${userId}`);
    await expect(billingKey("no-such-slug")).resolves.toBeNull();
    await expect(capture(endpoint.slug)).resolves.toMatchObject({
      status: "ok",
      billing_key: `user:${userId}`,
    });

    const slug = `guest${Date.now().toString(36)}`;
    const { data: guest, error } = await admin
      .from("endpoints")
      .insert({
        slug,
        is_ephemeral: true,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    createdEndpointIds.push(guest!.id);
    await expect(billingKey(slug)).resolves.toBe(`endpoint:${guest!.id}`);
    await expect(capture(slug)).resolves.toMatchObject({
      status: "ok",
      billing_key: `endpoint:${guest!.id}`,
    });
  });
});
