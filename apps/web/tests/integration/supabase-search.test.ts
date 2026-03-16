import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { countSearchRequestsForUser, searchRequestsForUser } from "@/lib/supabase/search";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEST_EMAIL = `test-search-${Date.now()}@webhooks-test.local`;
const TEST_PASSWORD = "TestPassword123!";

let testUserId: string;
let primaryEndpointId: string;
let primaryEndpointSlug: string;
let secondaryEndpointId: string;
let secondaryEndpointSlug: string;

async function insertRequest(input: {
  endpointId: string;
  path: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  receivedAt: number;
}) {
  const { error } = await admin.from("requests").insert({
    endpoint_id: input.endpointId,
    user_id: testUserId,
    method: input.method ?? "POST",
    path: input.path,
    headers: input.headers ?? {},
    body: input.body ?? null,
    query_params: {},
    content_type: "application/json",
    ip: "127.0.0.1",
    size: input.body?.length ?? 0,
    received_at: new Date(input.receivedAt).toISOString(),
  });

  if (error) {
    throw error;
  }
}

describe("Supabase Search Integration", () => {
  beforeAll(async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: "Search Test User",
      },
    });

    if (error) {
      throw error;
    }

    testUserId = data.user!.id;

    const primary = await createEndpointForUser({
      userId: testUserId,
      name: "Search Primary Endpoint",
    });
    primaryEndpointId = primary.id;
    primaryEndpointSlug = primary.slug;

    const secondary = await createEndpointForUser({
      userId: testUserId,
      name: "Search Secondary Endpoint",
    });
    secondaryEndpointId = secondary.id;
    secondaryEndpointSlug = secondary.slug;
  });

  afterAll(async () => {
    if (testUserId) {
      await admin.auth.admin.deleteUser(testUserId);
    }
  });

  it("searches retained requests across path, body, and headers while enforcing free retention", async () => {
    const now = Date.now();

    const { error: cleanupError } = await admin.from("requests").delete().eq("user_id", testUserId);
    expect(cleanupError).toBeNull();

    await insertRequest({
      endpointId: primaryEndpointId,
      path: "/stripe/webhook",
      body: '{"provider":"stripe","status":"ok"}',
      headers: { "x-provider": "stripe" },
      receivedAt: now - 60_000,
    });
    await insertRequest({
      endpointId: primaryEndpointId,
      path: "/github/webhook",
      method: "PUT",
      body: '{"provider":"github"}',
      headers: { "x-provider": "github" },
      receivedAt: now - 30_000,
    });
    await insertRequest({
      endpointId: secondaryEndpointId,
      path: "/other",
      body: '{"provider":"stripe","source":"secondary"}',
      headers: { "x-provider": "stripe" },
      receivedAt: now - 10_000,
    });
    await insertRequest({
      endpointId: primaryEndpointId,
      path: "/too-old",
      body: '{"provider":"stripe","status":"stale"}',
      headers: { "x-provider": "stripe" },
      receivedAt: now - 8 * 24 * 60 * 60 * 1000,
    });

    const freeResults = await searchRequestsForUser({
      userId: testUserId,
      plan: "free",
      q: "stripe",
      order: "desc",
    });

    expect(freeResults).toHaveLength(2);
    expect(freeResults.every((request) => request.path !== "/too-old")).toBe(true);
    expect(freeResults[0]?.slug).toBe(secondaryEndpointSlug);
    expect(freeResults[1]?.slug).toBe(primaryEndpointSlug);

    const bodyResults = await searchRequestsForUser({
      userId: testUserId,
      plan: "free",
      slug: primaryEndpointSlug,
      q: "github",
    });

    expect(bodyResults).toHaveLength(1);
    expect(bodyResults[0]?.method).toBe("PUT");

    const headerResults = await searchRequestsForUser({
      userId: testUserId,
      plan: "free",
      slug: primaryEndpointSlug,
      q: "x-provider",
    });

    expect(headerResults).toHaveLength(2);

    const proResults = await searchRequestsForUser({
      userId: testUserId,
      plan: "pro",
      slug: primaryEndpointSlug,
      q: "stripe",
    });

    expect(proResults.some((request) => request.path === "/too-old")).toBe(true);
  });

  it("supports method filters, offset pagination, and count queries", async () => {
    const now = Date.now();

    const { error: cleanupError } = await admin.from("requests").delete().eq("user_id", testUserId);
    expect(cleanupError).toBeNull();

    await insertRequest({
      endpointId: primaryEndpointId,
      path: "/first",
      method: "POST",
      body: '{"batch":1}',
      receivedAt: now - 3_000,
    });
    await insertRequest({
      endpointId: primaryEndpointId,
      path: "/second",
      method: "POST",
      body: '{"batch":2}',
      receivedAt: now - 2_000,
    });
    await insertRequest({
      endpointId: primaryEndpointId,
      path: "/third",
      method: "POST",
      body: '{"batch":3}',
      receivedAt: now - 1_000,
    });
    await insertRequest({
      endpointId: primaryEndpointId,
      path: "/ignored-get",
      method: "GET",
      body: '{"batch":4}',
      receivedAt: now - 500,
    });

    const page = await searchRequestsForUser({
      userId: testUserId,
      plan: "free",
      slug: primaryEndpointSlug,
      method: "POST",
      limit: 2,
      offset: 1,
      order: "desc",
    });

    expect(page).toHaveLength(2);
    expect(page.map((request) => request.path)).toEqual(["/second", "/first"]);

    const count = await countSearchRequestsForUser({
      userId: testUserId,
      plan: "free",
      slug: primaryEndpointSlug,
      method: "POST",
    });

    expect(count).toBe(3);
  });
});
