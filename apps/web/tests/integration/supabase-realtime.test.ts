import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";
import { createEndpointForUser } from "@/lib/supabase/endpoints";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const TEST_PASSWORD = "TestPassword123!";

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

if (!ANON_KEY) {
  throw new Error("SUPABASE_ANON_KEY env var required for integration tests");
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const callRpc = admin.rpc.bind(admin) as unknown as (
  functionName: string,
  params?: Record<string, unknown>
) => Promise<{ data: unknown; error: { message: string } | null }>;

function createAnonClient() {
  return createClient<Database>(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function waitForSubscribed(channel: RealtimeChannel): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for realtime subscription"));
    }, 10_000);

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timeout);
        resolve();
      }

      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timeout);
        reject(new Error(`Realtime subscription failed with status ${status}`));
      }
    });
  });

  // Give the server a brief moment to finish wiring the Postgres change feed
  // after the channel reports SUBSCRIBED. This avoids a race on fast updates.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

describe("Supabase Realtime Integration", () => {
  let testUserId = "";
  let testUserEmail = "";
  let testEndpointId = "";

  beforeAll(async () => {
    testUserEmail = `test-realtime-${Date.now()}@webhooks-test.local`;

    const { data, error } = await admin.auth.admin.createUser({
      email: testUserEmail,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: "Realtime Test User",
      },
    });

    expect(error).toBeNull();
    testUserId = data.user!.id;

    const endpoint = await createEndpointForUser({
      userId: testUserId,
      name: "Realtime Endpoint",
    });

    testEndpointId = endpoint.id;
  });

  afterAll(async () => {
    if (testEndpointId) {
      await admin.from("requests").delete().eq("endpoint_id", testEndpointId);
      await admin.from("endpoints").delete().eq("id", testEndpointId);
    }

    if (testUserId) {
      await admin.auth.admin.deleteUser(testUserId);
    }
  });

  it("delivers authenticated user row updates over realtime", async () => {
    const anonClient = createAnonClient();
    const signIn = await anonClient.auth.signInWithPassword({
      email: testUserEmail,
      password: TEST_PASSWORD,
    });

    expect(signIn.error).toBeNull();

    const channel = anonClient.channel(`test-users-${testUserId}`);
    const updatePromise = new Promise<Database["public"]["Tables"]["users"]["Row"]>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for user realtime update"));
        }, 10_000);

        channel.on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "users",
            filter: `id=eq.${testUserId}`,
          },
          (payload) => {
            clearTimeout(timeout);
            resolve(payload.new as Database["public"]["Tables"]["users"]["Row"]);
          }
        );
      }
    );

    await waitForSubscribed(channel);

    const { error: updateError } = await admin
      .from("users")
      .update({
        requests_used: 7,
        subscription_status: "past_due",
      })
      .eq("id", testUserId);

    expect(updateError).toBeNull();

    await expect(updatePromise).resolves.toMatchObject({
      id: testUserId,
      requests_used: 7,
      subscription_status: "past_due",
    });

    await anonClient.removeChannel(channel);
    await anonClient.auth.signOut();
  }, 20_000);

  it("delivers retained request inserts for an owned endpoint over realtime", async () => {
    const anonClient = createAnonClient();
    const signIn = await anonClient.auth.signInWithPassword({
      email: testUserEmail,
      password: TEST_PASSWORD,
    });

    expect(signIn.error).toBeNull();

    const channel = anonClient.channel(`test-requests-${testEndpointId}`);
    const requestPromise = new Promise<Database["public"]["Tables"]["requests"]["Row"]>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for request realtime insert"));
        }, 10_000);

        channel.on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "requests",
            filter: `endpoint_id=eq.${testEndpointId}`,
          },
          (payload) => {
            clearTimeout(timeout);
            resolve(payload.new as Database["public"]["Tables"]["requests"]["Row"]);
          }
        );
      }
    );

    await waitForSubscribed(channel);

    const { error: insertError } = await admin.from("requests").insert({
      endpoint_id: testEndpointId,
      user_id: testUserId,
      method: "POST",
      path: "/realtime-test",
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
      query_params: { source: "realtime" },
      content_type: "application/json",
      ip: "127.0.0.1",
      size: 11,
    });

    expect(insertError).toBeNull();

    await expect(requestPromise).resolves.toMatchObject({
      endpoint_id: testEndpointId,
      user_id: testUserId,
      method: "POST",
      path: "/realtime-test",
    });

    await anonClient.removeChannel(channel);
    await anonClient.auth.signOut();
  }, 20_000);

  it("delivers owned endpoint row updates over realtime", async () => {
    const anonClient = createAnonClient();
    const signIn = await anonClient.auth.signInWithPassword({
      email: testUserEmail,
      password: TEST_PASSWORD,
    });

    expect(signIn.error).toBeNull();

    const channel = anonClient.channel(`test-owned-endpoint-${testEndpointId}`);
    const updatePromise = new Promise<Database["public"]["Tables"]["endpoints"]["Row"]>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for owned endpoint realtime update"));
        }, 10_000);

        channel.on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "endpoints",
            filter: `id=eq.${testEndpointId}`,
          },
          (payload) => {
            clearTimeout(timeout);
            resolve(payload.new as Database["public"]["Tables"]["endpoints"]["Row"]);
          }
        );
      }
    );

    await waitForSubscribed(channel);

    const { error: countError } = await callRpc("increment_endpoint_request_count", {
      p_endpoint_id: testEndpointId,
      p_count: 1,
    });

    expect(countError).toBeNull();

    await expect(updatePromise).resolves.toMatchObject({
      id: testEndpointId,
    });

    await anonClient.removeChannel(channel);
    await anonClient.auth.signOut();
  }, 20_000);
});
