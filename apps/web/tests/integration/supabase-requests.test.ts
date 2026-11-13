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
    expect(listed?.[0].detectedProvider).toBeNull();
    expect(listed?.[0].detectedEvent).toBeNull();

    const fetched = await getRequestByIdForUser(testUserId, recentId);
    expect(fetched?.path).toBe("/recent");
    expect(fetched?.contentType).toBe("application/json");
    expect(fetched?.detectedProvider).toBeNull();
    expect(fetched?.detectedEvent).toBeNull();
  });

  it("derives detected provider and event from stored request headers/body", async () => {
    await clearRequestsForEndpointByUser({
      userId: testUserId,
      slug: testEndpointSlug,
    });

    const { data, error } = await admin
      .from("requests")
      .insert({
        endpoint_id: testEndpointId,
        user_id: testUserId,
        method: "POST",
        path: "/stripe",
        headers: { "stripe-signature": "t=123,v1=abc" },
        body: '{"type":"checkout.session.completed"}',
        query_params: {},
        content_type: "application/json",
        ip: "127.0.0.1",
        size: 37,
        received_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error) {
      throw error;
    }

    const request = await getRequestByIdForUser(testUserId, data.id);
    expect(request?.detectedProvider).toBe("stripe");
    expect(request?.detectedEvent).toBe("checkout.session.completed");
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

  it("keeps pages exact when requests arrive or are deleted between pages", async () => {
    await clearRequestsForEndpointByUser({ userId: testUserId, slug: testEndpointSlug });
    const now = Date.now();
    const ids: Record<string, string> = {};
    for (const [index, path] of ["/a", "/b", "/c", "/d", "/e"].entries()) {
      ids[path] = await insertRequest(path, now - (index + 1) * 1_000);
    }
    const page = (cursor?: string) =>
      listPaginatedRequestsForEndpointByUser({
        userId: testUserId,
        slug: testEndpointSlug,
        limit: 2,
        cursor,
      });

    const first = await page();
    expect(first?.items.map((item) => item.path)).toEqual(["/a", "/b"]);

    // A deletion above the cursor: an offset cursor would skip /c.
    const { error } = await admin.from("requests").delete().eq("id", ids["/a"]);
    expect(error).toBeNull();
    const second = await page(first?.cursor);
    expect(second?.items.map((item) => item.path)).toEqual(["/c", "/d"]);

    // New requests at the top: an offset cursor would repeat /d.
    await insertRequest("/new", now);
    await insertRequest("/newer", now + 1_000);
    const third = await page(second?.cursor);
    expect(third?.items.map((item) => item.path)).toEqual(["/e"]);
    expect(third?.hasMore).toBe(false);
  });

  it("still reads an offset cursor written before keyset cursors", async () => {
    await clearRequestsForEndpointByUser({ userId: testUserId, slug: testEndpointSlug });
    const now = Date.now();
    await insertRequest("/x", now - 1_000);
    await insertRequest("/y", now - 2_000);
    await insertRequest("/z", now - 3_000);
    const legacy = Buffer.from(JSON.stringify({ offset: 1, cutoff: 0 })).toString("base64url");
    const result = await listPaginatedRequestsForEndpointByUser({
      userId: testUserId,
      slug: testEndpointSlug,
      limit: 1,
      cursor: legacy,
    });
    expect(result?.items.map((item) => item.path)).toEqual(["/y"]);
    // The next cursor is a keyset one and carries on from there.
    const next = await listPaginatedRequestsForEndpointByUser({
      userId: testUserId,
      slug: testEndpointSlug,
      limit: 1,
      cursor: result?.cursor,
    });
    expect(next?.items.map((item) => item.path)).toEqual(["/z"]);
  });

  it("refuses a cursor whose position is not a timestamp and a uuid", async () => {
    const forged = Buffer.from(
      JSON.stringify({
        at: "2026-01-01T00:00:00Z,id.not.is.null",
        id: "00000000-0000-0000-0000-000000000000",
        cutoff: 0,
      })
    ).toString("base64url");
    await expect(
      listPaginatedRequestsForEndpointByUser({
        userId: testUserId,
        slug: testEndpointSlug,
        cursor: forged,
      })
    ).rejects.toThrow("invalid_cursor");
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
