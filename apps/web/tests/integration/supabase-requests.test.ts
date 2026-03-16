import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import {
  clearRequestsForEndpointByUser,
  getRequestByIdForUser,
  listPaginatedRequestsForEndpointByUser,
  listRequestsForEndpointByUser,
} from "@/lib/supabase/requests";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEST_EMAIL = `test-requests-${Date.now()}@webhooks-test.local`;
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
      query_params: { page: "1" },
      content_type: "application/json",
      ip: "127.0.0.1",
      size: 11,
      received_at: new Date(receivedAt).toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    throw error;
  }

  return data.id;
}

describe("Supabase Requests Integration", () => {
  beforeAll(async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: "Requests Test User",
      },
    });

    if (error) {
      throw error;
    }

    testUserId = data.user!.id;

    const endpoint = await createEndpointForUser({
      userId: testUserId,
      name: "Requests Endpoint",
    });

    testEndpointId = endpoint.id;
    testEndpointSlug = endpoint.slug;
  });

  afterAll(async () => {
    if (testUserId) {
      await admin.auth.admin.deleteUser(testUserId);
    }
  });

  it("lists and fetches retained requests for an owned endpoint", async () => {
    const recentId = await insertRequest("/recent", Date.now() - 60_000);
    await insertRequest("/too-old", Date.now() - 8 * 24 * 60 * 60 * 1000);

    const listed = await listRequestsForEndpointByUser({
      userId: testUserId,
      slug: testEndpointSlug,
      limit: 10,
    });

    expect(listed).toHaveLength(1);
    expect(listed?.[0].id).toBe(recentId);
    expect(listed?.[0].endpointId).toBe(testEndpointId);
    expect(listed?.[0].queryParams).toEqual({ page: "1" });

    const fetched = await getRequestByIdForUser(testUserId, recentId);
    expect(fetched?.path).toBe("/recent");
    expect(fetched?.contentType).toBe("application/json");
  });

  it("paginates requests with an opaque cursor", async () => {
    await clearRequestsForEndpointByUser({
      userId: testUserId,
      slug: testEndpointSlug,
    });

    await insertRequest("/one", Date.now() - 1_000);
    await insertRequest("/two", Date.now() - 2_000);
    await insertRequest("/three", Date.now() - 3_000);

    const firstPage = await listPaginatedRequestsForEndpointByUser({
      userId: testUserId,
      slug: testEndpointSlug,
      limit: 2,
    });

    expect(firstPage?.items).toHaveLength(2);
    expect(firstPage?.hasMore).toBe(true);
    expect(firstPage?.cursor).toBeTruthy();

    const secondPage = await listPaginatedRequestsForEndpointByUser({
      userId: testUserId,
      slug: testEndpointSlug,
      limit: 2,
      cursor: firstPage?.cursor,
    });

    expect(secondPage?.items).toHaveLength(1);
    expect(secondPage?.hasMore).toBe(false);
    expect(secondPage?.items[0]?.path).toBe("/three");
  });

  it("clears endpoint requests and reports the delete count", async () => {
    await clearRequestsForEndpointByUser({
      userId: testUserId,
      slug: testEndpointSlug,
    });

    await insertRequest("/delete-a", Date.now() - 5_000);
    await insertRequest("/delete-b", Date.now() - 4_000);

    const cleared = await clearRequestsForEndpointByUser({
      userId: testUserId,
      slug: testEndpointSlug,
    });

    expect(cleared).toEqual({
      deleted: 2,
      complete: true,
    });

    const remaining = await listRequestsForEndpointByUser({
      userId: testUserId,
      slug: testEndpointSlug,
      limit: 10,
    });

    expect(remaining).toEqual([]);
  });
});
