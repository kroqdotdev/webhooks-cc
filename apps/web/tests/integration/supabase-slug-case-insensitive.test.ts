import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";
import {
  createEndpointForUser,
  deleteEndpointBySlugForUser,
  getEndpointBySlugForUser,
  updateEndpointBySlugForUser,
} from "@/lib/supabase/endpoints";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const RECEIVER_URL = process.env.NEXT_PUBLIC_WEBHOOK_URL ?? "http://localhost:3001";

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

describe("Case-Insensitive Slug Handling", () => {
  let testUserId: string;
  const endpointIds: string[] = [];

  beforeAll(async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: `test-slug-case-${Date.now()}@webhooks-test.local`,
      password: "TestPassword123!",
      email_confirm: true,
      user_metadata: { full_name: "Slug Case Test User" },
    });

    expect(error).toBeNull();
    testUserId = data.user!.id;
  });

  afterAll(async () => {
    for (const id of endpointIds) {
      await admin.from("requests").delete().eq("endpoint_id", id);
      await admin.from("endpoints").delete().eq("id", id);
    }
    if (testUserId) {
      await admin.auth.admin.deleteUser(testUserId);
    }
  });

  it("generates lowercase-only slugs with length 10", async () => {
    const endpoint = await createEndpointForUser({
      userId: testUserId,
      name: "Slug Format Test",
    });

    endpointIds.push(endpoint.id);

    expect(endpoint.slug).toHaveLength(10);
    expect(endpoint.slug).toMatch(/^[a-z0-9]+$/);
  });

  it("looks up endpoints case-insensitively via lib functions", async () => {
    const endpoint = await createEndpointForUser({
      userId: testUserId,
      name: "Case Lookup Test",
    });

    endpointIds.push(endpoint.id);

    // Lookup with exact lowercase slug
    const exact = await getEndpointBySlugForUser(testUserId, endpoint.slug);
    expect(exact?.id).toBe(endpoint.id);

    // Lookup with uppercase slug
    const upper = await getEndpointBySlugForUser(testUserId, endpoint.slug.toUpperCase());
    expect(upper?.id).toBe(endpoint.id);

    // Lookup with mixed case slug
    const mixed = await getEndpointBySlugForUser(
      testUserId,
      endpoint.slug[0]!.toUpperCase() + endpoint.slug.slice(1)
    );
    expect(mixed?.id).toBe(endpoint.id);
  });

  it("updates endpoints case-insensitively", async () => {
    const endpoint = await createEndpointForUser({
      userId: testUserId,
      name: "Case Update Test",
    });

    endpointIds.push(endpoint.id);

    const updated = await updateEndpointBySlugForUser({
      userId: testUserId,
      slug: endpoint.slug.toUpperCase(),
      name: "Updated Name",
    });

    expect(updated?.name).toBe("Updated Name");
    expect(updated?.id).toBe(endpoint.id);
  });

  it("deletes endpoints case-insensitively", async () => {
    const endpoint = await createEndpointForUser({
      userId: testUserId,
      name: "Case Delete Test",
    });

    // Don't track — we're deleting it ourselves
    const deleted = await deleteEndpointBySlugForUser(testUserId, endpoint.slug.toUpperCase());
    expect(deleted).toBe(true);

    const gone = await getEndpointBySlugForUser(testUserId, endpoint.slug);
    expect(gone).toBeNull();
  });

  it("capture_webhook() handles case-insensitive slug via receiver", async () => {
    const endpoint = await createEndpointForUser({
      userId: testUserId,
      name: "Receiver Case Test",
    });

    endpointIds.push(endpoint.id);

    // Send webhook with exact lowercase slug
    const res1 = await fetch(`${RECEIVER_URL}/w/${endpoint.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test: "lowercase" }),
    });
    expect(res1.status).toBe(200);

    // Send webhook with uppercase slug
    const res2 = await fetch(`${RECEIVER_URL}/w/${endpoint.slug.toUpperCase()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test: "uppercase" }),
    });
    expect(res2.status).toBe(200);

    // Send webhook with mixed case slug
    const mixedSlug = endpoint.slug[0]!.toUpperCase() + endpoint.slug.slice(1);
    const res3 = await fetch(`${RECEIVER_URL}/w/${mixedSlug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test: "mixed" }),
    });
    expect(res3.status).toBe(200);

    // Verify all 3 requests were captured
    const { data: requests, error } = await admin
      .from("requests")
      .select("id, body")
      .eq("endpoint_id", endpoint.id)
      .order("received_at", { ascending: true });

    expect(error).toBeNull();
    expect(requests).toHaveLength(3);
    expect(requests![0]!.body).toContain("lowercase");
    expect(requests![1]!.body).toContain("uppercase");
    expect(requests![2]!.body).toContain("mixed");
  });

  it("receiver returns 404 for nonexistent slugs regardless of case", async () => {
    const res = await fetch(`${RECEIVER_URL}/w/NONEXISTENT99`, {
      method: "POST",
      body: "test",
    });
    expect(res.status).toBe(404);
  });

  it("capture_webhook() with mock response works case-insensitively", async () => {
    const endpoint = await createEndpointForUser({
      userId: testUserId,
      name: "Mock Case Test",
      mockResponse: {
        status: 201,
        body: '{"mocked":true}',
        headers: { "x-mock": "yes" },
      },
    });

    endpointIds.push(endpoint.id);

    // Hit with uppercase slug — should still return mock response
    const res = await fetch(`${RECEIVER_URL}/w/${endpoint.slug.toUpperCase()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(201);
    expect(res.headers.get("x-mock")).toBe("yes");
    const body = await res.json();
    expect(body).toEqual({ mocked: true });
  });
});
