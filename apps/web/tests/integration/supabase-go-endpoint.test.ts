import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";
import { POST as createEndpointRoute } from "@/app/api/endpoints/route";
import { POST as createGuestEndpointRoute } from "@/app/api/go/endpoint/route";

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

function createAnonClient() {
  return createClient<Database>(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function guestRequest(ip: string): Request {
  return new Request("https://webhooks.cc/api/go/endpoint", {
    method: "POST",
    headers: {
      "x-forwarded-for": ip,
    },
  });
}

function authRequest(path: string, accessToken: string, body: unknown): Request {
  return new Request(`https://webhooks.cc${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Supabase Guest Endpoint Integration", () => {
  let testUserId = "";
  let testEmail = "";
  let accessToken = "";
  const guestEndpointIds = new Set<string>();

  beforeAll(async () => {
    testEmail = `test-go-endpoint-${Date.now()}@webhooks-test.local`;

    const { data, error } = await admin.auth.admin.createUser({
      email: testEmail,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: "Guest Endpoint Test User",
      },
    });

    expect(error).toBeNull();
    testUserId = data.user!.id;

    const anonClient = createAnonClient();
    const signIn = await anonClient.auth.signInWithPassword({
      email: testEmail,
      password: TEST_PASSWORD,
    });

    expect(signIn.error).toBeNull();
    accessToken = signIn.data.session!.access_token;
  });

  afterAll(async () => {
    if (guestEndpointIds.size > 0) {
      const endpointIds = [...guestEndpointIds];
      await admin.from("requests").delete().in("endpoint_id", endpointIds);
      await admin.from("endpoints").delete().in("id", endpointIds);
    }

    if (testUserId) {
      await admin.auth.admin.deleteUser(testUserId);
    }
  });

  it("creates a guest endpoint and blocks anonymous direct reads (RLS hardened)", async () => {
    const response = await createGuestEndpointRoute(guestRequest("198.51.100.10"));

    expect(response.status).toBe(200);
    const endpoint = (await response.json()) as {
      id: string;
      slug: string;
      isEphemeral?: boolean;
      expiresAt?: number;
      requestCount: number;
    };

    guestEndpointIds.add(endpoint.id);

    expect(endpoint.slug).toHaveLength(8);
    expect(endpoint.isEphemeral).toBe(true);
    expect(endpoint.expiresAt).toBeGreaterThan(Date.now());
    expect(endpoint.requestCount).toBe(0);

    // Verify the endpoint exists via admin (service role bypasses RLS)
    const { data: endpointRow, error: endpointError } = await admin
      .from("endpoints")
      .select("id, slug, is_ephemeral")
      .eq("id", endpoint.id)
      .single();

    expect(endpointError).toBeNull();
    expect(endpointRow).toMatchObject({
      id: endpoint.id,
      slug: endpoint.slug,
      is_ephemeral: true,
    });

    // Anonymous direct reads should be blocked by RLS
    const anonClient = createAnonClient();
    const { data: anonEndpoint } = await anonClient
      .from("endpoints")
      .select("id")
      .eq("id", endpoint.id)
      .maybeSingle();

    expect(anonEndpoint).toBeNull();

    // Insert a request via admin (service role)
    const { error: requestInsertError } = await admin.from("requests").insert({
      endpoint_id: endpoint.id,
      user_id: null,
      method: "POST",
      path: "/guest-visible",
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
      query_params: { source: "guest" },
      content_type: "application/json",
      ip: "127.0.0.1",
      size: 11,
    });

    expect(requestInsertError).toBeNull();

    // Anonymous direct request reads should also be blocked
    const { data: anonRequests } = await anonClient
      .from("requests")
      .select("endpoint_id")
      .eq("endpoint_id", endpoint.id);

    expect(anonRequests).toEqual([]);
  });

  it("rate limits anonymous guest endpoint creation by IP", async () => {
    const ip = "198.51.100.25";

    for (let i = 0; i < 20; i += 1) {
      const response = await createGuestEndpointRoute(guestRequest(ip));
      expect(response.status).toBe(200);
      const endpoint = (await response.json()) as { id: string };
      guestEndpointIds.add(endpoint.id);
    }

    const rateLimited = await createGuestEndpointRoute(guestRequest(ip));
    expect(rateLimited.status).toBe(429);
    await expect(rateLimited.json()).resolves.toEqual({ error: "Too many requests" });
  });

  it("rate limits authenticated endpoint creation by user", async () => {
    for (let i = 0; i < 10; i += 1) {
      const response = await createEndpointRoute(authRequest("/api/endpoints", accessToken, {}));
      expect(response.status).toBe(200);
    }

    const rateLimited = await createEndpointRoute(authRequest("/api/endpoints", accessToken, {}));
    expect(rateLimited.status).toBe(429);
    await expect(rateLimited.json()).resolves.toEqual({ error: "Too many requests" });
  });
});
