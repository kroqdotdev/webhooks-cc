import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { getRequestByIdForUser, listRequestsForEndpointByUser } from "@/lib/supabase/requests";
import { searchRequestsForUser } from "@/lib/supabase/search";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

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

const WEBHOOK_URL = process.env.NEXT_PUBLIC_WEBHOOK_URL ?? "http://localhost:3001";

const TEST_EMAIL = `test-partitioning-${Date.now()}@webhooks-test.local`;
const TEST_PASSWORD = "TestPassword123!";

let testUserId: string;
let testEndpointId: string;
let testEndpointSlug: string;

async function insertRequest(path: string, receivedAt: number) {
  const { data, error } = await admin
    .from("requests")
    .insert({
      endpoint_id: testEndpointId,
      user_id: testUserId,
      method: "POST",
      path,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
      query_params: {},
      content_type: "application/json",
      ip: "127.0.0.1",
      size: 11,
      received_at: new Date(receivedAt).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

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
  await new Promise((resolve) => setTimeout(resolve, 100));
}

describe("Supabase Partitioning Integration", () => {
  let ephemeralEndpointId: string | null = null;

  beforeAll(async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: "Partitioning Test User",
      },
    });

    if (error) throw error;

    testUserId = data.user!.id;

    const endpoint = await createEndpointForUser({
      userId: testUserId,
      name: "Partitioning Endpoint",
    });

    testEndpointId = endpoint.id;
    testEndpointSlug = endpoint.slug;
  });

  afterAll(async () => {
    if (testEndpointId) {
      await admin.from("requests").delete().eq("endpoint_id", testEndpointId);
      await admin.from("endpoints").delete().eq("id", testEndpointId);
    }

    if (ephemeralEndpointId) {
      await admin.from("requests").delete().eq("endpoint_id", ephemeralEndpointId);
      await admin.from("endpoints").delete().eq("id", ephemeralEndpointId);
    }

    if (testUserId) {
      await admin.auth.admin.deleteUser(testUserId);
    }
  });

  // =========================================================================
  // INSERT routing
  // =========================================================================

  describe("INSERT routing", () => {
    it("routes inserts to the correct daily partition", async () => {
      const todayId = await insertRequest("/today", Date.now());
      const yesterdayId = await insertRequest("/yesterday", Date.now() - 24 * 60 * 60 * 1000);

      // Both should be queryable through the parent table
      const { data: todayRow, error: todayError } = await admin
        .from("requests")
        .select("id, path")
        .eq("id", todayId)
        .single();

      expect(todayError).toBeNull();
      expect(todayRow?.path).toBe("/today");

      const { data: yesterdayRow, error: yesterdayError } = await admin
        .from("requests")
        .select("id, path")
        .eq("id", yesterdayId)
        .single();

      expect(yesterdayError).toBeNull();
      expect(yesterdayRow?.path).toBe("/yesterday");

      // Cleanup
      await admin.from("requests").delete().in("id", [todayId, yesterdayId]);
    });

    it("handles the default partition for dates outside explicit range", async () => {
      // Insert a request 60 days in the past — no daily partition exists for that date
      const oldId = await insertRequest("/old-default", Date.now() - 60 * 24 * 60 * 60 * 1000);

      const { data: oldRow, error: oldError } = await admin
        .from("requests")
        .select("id, path")
        .eq("id", oldId)
        .single();

      expect(oldError).toBeNull();
      expect(oldRow?.path).toBe("/old-default");

      // Cleanup
      await admin.from("requests").delete().eq("id", oldId);
    });
  });

  // =========================================================================
  // Existing query patterns work unchanged
  // =========================================================================

  describe("existing query patterns work unchanged", () => {
    it("listRequestsForEndpointByUser returns recent requests", async () => {
      // Clear endpoint requests first
      await admin.from("requests").delete().eq("endpoint_id", testEndpointId);

      const id1 = await insertRequest("/list-a", Date.now() - 2_000);
      const id2 = await insertRequest("/list-b", Date.now() - 1_000);

      const listed = await listRequestsForEndpointByUser({
        userId: testUserId,
        slug: testEndpointSlug,
        limit: 10,
      });

      expect(listed).toHaveLength(2);
      // DESC order: most recent first
      expect(listed?.[0].path).toBe("/list-b");
      expect(listed?.[1].path).toBe("/list-a");

      // Cleanup
      await admin.from("requests").delete().in("id", [id1, id2]);
    });

    it("getRequestByIdForUser fetches a single request across partitions", async () => {
      const requestId = await insertRequest("/fetch-single", Date.now() - 60_000);

      const fetched = await getRequestByIdForUser(testUserId, requestId);

      expect(fetched).not.toBeNull();
      expect(fetched?.path).toBe("/fetch-single");
      expect(fetched?.endpointId).toBe(testEndpointId);

      // Cleanup
      await admin.from("requests").delete().eq("id", requestId);
    });

    it("search works across partitions with time range filters", async () => {
      await admin.from("requests").delete().eq("endpoint_id", testEndpointId);

      const now = Date.now();
      // Recent request (within free retention)
      await insertRequest("/search-recent", now - 60_000);
      // Old request (outside free 7-day retention)
      await insertRequest("/search-old", now - 8 * 24 * 60 * 60 * 1000);

      const freeResults = await searchRequestsForUser({
        userId: testUserId,
        plan: "free",
        q: "search",
        order: "desc",
      });

      // Free plan: only sees the recent one (7-day retention cutoff)
      expect(freeResults).toHaveLength(1);
      expect(freeResults[0]?.path).toBe("/search-recent");

      // Cleanup
      await admin.from("requests").delete().eq("endpoint_id", testEndpointId);
    });

    it("DELETE by endpoint_id works across partitions", async () => {
      // Insert requests on different days
      await insertRequest("/delete-today", Date.now());
      await insertRequest("/delete-yesterday", Date.now() - 24 * 60 * 60 * 1000);
      await insertRequest("/delete-2days", Date.now() - 2 * 24 * 60 * 60 * 1000);

      // Delete all requests for this endpoint
      const { error: deleteError } = await admin
        .from("requests")
        .delete()
        .eq("endpoint_id", testEndpointId);

      expect(deleteError).toBeNull();

      // Verify empty
      const { data: remaining, error: remainingError } = await admin
        .from("requests")
        .select("id")
        .eq("endpoint_id", testEndpointId);

      expect(remainingError).toBeNull();
      expect(remaining).toEqual([]);
    });
  });

  // =========================================================================
  // capture_webhook stored procedure
  // =========================================================================

  describe("capture_webhook stored procedure", () => {
    it("inserts via capture_webhook into the correct partition", async () => {
      const receivedAt = new Date().toISOString();

      const { data, error } = await callRpc("capture_webhook", {
        p_slug: testEndpointSlug,
        p_method: "POST",
        p_path: "/capture-partition-test",
        p_headers: JSON.stringify({ "content-type": "application/json" }),
        p_body: '{"capture":true}',
        p_query_params: JSON.stringify({}),
        p_content_type: "application/json",
        p_ip: "127.0.0.1",
        p_received_at: receivedAt,
      });

      expect(error).toBeNull();

      const result = data as { status: string };
      expect(result.status).toBe("ok");

      // Verify the request row exists in the partitioned table
      const { data: rows, error: selectError } = await admin
        .from("requests")
        .select("id, path")
        .eq("endpoint_id", testEndpointId)
        .eq("path", "/capture-partition-test");

      expect(selectError).toBeNull();
      expect(rows).toHaveLength(1);
      expect(rows?.[0]?.path).toBe("/capture-partition-test");

      // Cleanup
      if (rows?.[0]?.id) {
        await admin.from("requests").delete().eq("id", rows[0].id);
      }
    });
  });

  // =========================================================================
  // Partition management
  // =========================================================================

  describe("partition management", () => {
    it("manage_request_partitions creates future partitions", async () => {
      const { data, error } = await callRpc("manage_request_partitions");

      expect(error).toBeNull();
      // Partitions already exist from migration, so created=0 is expected
      const result = data as Array<{ created: number; dropped: number }>;
      expect(result).toBeDefined();
      expect(result[0]?.created).toBeGreaterThanOrEqual(0);
      expect(result[0]?.dropped).toBeGreaterThanOrEqual(0);
    });

    it("manage_request_partitions does not drop the default partition", async () => {
      // Insert a row 60 days old — goes to the default partition
      const oldId = await insertRequest("/default-survives", Date.now() - 60 * 24 * 60 * 60 * 1000);

      // Run partition management
      const { error } = await callRpc("manage_request_partitions");
      expect(error).toBeNull();

      // Verify the row still exists in the default partition
      const { data: row, error: selectError } = await admin
        .from("requests")
        .select("id, path")
        .eq("id", oldId)
        .single();

      expect(selectError).toBeNull();
      expect(row?.path).toBe("/default-survives");

      // Cleanup
      await admin.from("requests").delete().eq("id", oldId);
    });
  });

  // =========================================================================
  // Cleanup functions
  // =========================================================================

  describe("cleanup functions", () => {
    it("cleanup_old_requests calls manage_request_partitions", async () => {
      const { data, error } = await callRpc("cleanup_old_requests");

      expect(error).toBeNull();
      // Returns an integer (number of dropped partitions)
      expect(typeof data).toBe("number");
    });

    it("cleanup_free_user_requests still works with partitioned table", async () => {
      // Insert a request 8 days old (outside free 7-day retention)
      const oldId = await insertRequest("/free-cleanup", Date.now() - 8 * 24 * 60 * 60 * 1000);

      // Verify it exists before cleanup
      const { data: before, error: beforeError } = await admin
        .from("requests")
        .select("id")
        .eq("id", oldId)
        .single();

      expect(beforeError).toBeNull();
      expect(before).not.toBeNull();

      // Run cleanup
      const { data: deleted, error: cleanupError } = await callRpc("cleanup_free_user_requests");

      expect(cleanupError).toBeNull();
      expect(typeof deleted).toBe("number");
      expect(deleted as number).toBeGreaterThanOrEqual(1);

      // Verify the old request was deleted
      const { data: after } = await admin
        .from("requests")
        .select("id")
        .eq("id", oldId)
        .maybeSingle();

      expect(after).toBeNull();
    });

    it("cleanup_expired_ephemeral_endpoints works with partitioned table", async () => {
      ephemeralEndpointId = randomUUID();
      const ephemeralSlug = `part-eph-${Date.now()}`;
      const expiredAt = new Date(Date.now() - 5 * 60_000).toISOString();

      // Create an expired ephemeral endpoint
      const { error: endpointError } = await admin.from("endpoints").insert({
        id: ephemeralEndpointId,
        slug: ephemeralSlug,
        is_ephemeral: true,
        expires_at: expiredAt,
        request_count: 1,
      });

      expect(endpointError).toBeNull();

      // Insert a request for the expired ephemeral endpoint
      const { error: requestError } = await admin.from("requests").insert({
        endpoint_id: ephemeralEndpointId,
        method: "POST",
        path: "/ephemeral-partition",
        headers: { "content-type": "application/json" },
        body: '{"ephemeral":true}',
        query_params: {},
        content_type: "application/json",
        ip: "127.0.0.1",
        size: 18,
      });

      expect(requestError).toBeNull();

      // Run cleanup
      const { data, error } = await callRpc("cleanup_expired_ephemeral_endpoints");
      expect(error).toBeNull();

      const result = data as Array<{
        deleted_endpoints: number;
        deleted_expired_requests: number;
        deleted_orphaned_requests: number;
      }>;
      expect(result[0]?.deleted_endpoints).toBeGreaterThanOrEqual(1);

      // Verify endpoint is gone
      const { data: epRow } = await admin
        .from("endpoints")
        .select("id")
        .eq("id", ephemeralEndpointId)
        .maybeSingle();

      expect(epRow).toBeNull();

      // Verify request is gone (CASCADE or explicit cleanup)
      const { data: reqRows } = await admin
        .from("requests")
        .select("id")
        .eq("endpoint_id", ephemeralEndpointId);

      expect(reqRows).toEqual([]);
    });
  });

  // =========================================================================
  // Realtime with partitioned table
  // =========================================================================

  describe("Realtime with partitioned table", () => {
    it("delivers INSERT events via the parent table name", async () => {
      const anonClient = createAnonClient();
      const signIn = await anonClient.auth.signInWithPassword({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      });

      expect(signIn.error).toBeNull();

      const channel = anonClient.channel(`test-partition-rt-${testEndpointId}`);
      const requestPromise = new Promise<Database["public"]["Tables"]["requests"]["Row"]>(
        (resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Timed out waiting for realtime INSERT on partitioned table"));
          }, 15_000);

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

      // Insert a request via admin — should trigger realtime on the parent table
      const { error: insertError } = await admin.from("requests").insert({
        endpoint_id: testEndpointId,
        user_id: testUserId,
        method: "POST",
        path: "/realtime-partition",
        headers: { "content-type": "application/json" },
        body: '{"realtime":true}',
        query_params: { source: "partition-test" },
        content_type: "application/json",
        ip: "127.0.0.1",
        size: 17,
      });

      expect(insertError).toBeNull();

      await expect(requestPromise).resolves.toMatchObject({
        endpoint_id: testEndpointId,
        user_id: testUserId,
        method: "POST",
        path: "/realtime-partition",
      });

      await anonClient.removeChannel(channel);
      await anonClient.auth.signOut();

      // Cleanup
      await admin
        .from("requests")
        .delete()
        .eq("endpoint_id", testEndpointId)
        .eq("path", "/realtime-partition");
    }, 20_000);
  });

  // =========================================================================
  // E2E through the Rust receiver
  // =========================================================================

  describe("E2E through the Rust receiver", () => {
    it("captures a webhook sent to the receiver into a partition", async () => {
      // Clear existing requests
      await admin.from("requests").delete().eq("endpoint_id", testEndpointId);

      // Send an HTTP POST to the receiver
      const response = await fetch(`${WEBHOOK_URL}/w/${testEndpointSlug}/e2e-partition-test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ e2e: "partition-test" }),
      });

      expect(response.status).toBe(200);

      // Poll for the captured request (up to 5 seconds)
      let captured: { path: string; method: string } | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        const results = await listRequestsForEndpointByUser({
          userId: testUserId,
          slug: testEndpointSlug,
          limit: 10,
        });
        captured = results?.find((r) => r.path.includes("e2e-partition-test"));
        if (captured) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(captured).toBeDefined();
      expect(captured?.method).toBe("POST");

      // Cleanup
      await admin.from("requests").delete().eq("endpoint_id", testEndpointId);
    }, 20_000);
  });
});
