import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { GET as streamRoute } from "@/app/api/stream/[slug]/route";

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

function authRequest(path: string, accessToken: string, signal: AbortSignal): Request {
  return new Request(`https://webhooks.cc${path}`, {
    method: "GET",
    signal,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "text/event-stream",
    },
  });
}

async function waitForEvent(
  stream: ReadableStream<Uint8Array>,
  expectedEvent: string
): Promise<{ event: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${expectedEvent} event`));
      }, 10_000);

      const parseFrame = (frame: string) => {
        const lines = frame.split("\n");
        let event = "message";
        const dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith("event:")) {
            event = line.slice(6).trim();
            continue;
          }
          if (line.startsWith("data:")) {
            let value = line.slice(5);
            if (value.startsWith(" ")) {
              value = value.slice(1);
            }
            dataLines.push(value);
          }
        }

        return {
          event,
          data: dataLines.join("\n"),
        };
      };

      const pump = async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            clearTimeout(timeout);
            reject(new Error(`Stream closed before ${expectedEvent} event arrived`));
            return;
          }

          buffer += decoder.decode(value, { stream: true });

          while (true) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary === -1) break;

            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (!frame || frame.startsWith(":")) {
              continue;
            }

            const parsed = parseFrame(frame);
            if (parsed.event === expectedEvent) {
              clearTimeout(timeout);
              resolve(parsed);
              return;
            }
          }
        }
      };

      void pump().catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } finally {
    await reader.cancel();
  }
}

describe("Supabase Stream Route Integration", () => {
  let testUserId = "";
  let testUserEmail = "";
  let testEndpointId = "";
  let testEndpointSlug = "";

  beforeAll(async () => {
    testUserEmail = `test-stream-${Date.now()}@webhooks-test.local`;

    const { data, error } = await admin.auth.admin.createUser({
      email: testUserEmail,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: "Stream Test User",
      },
    });

    expect(error).toBeNull();
    testUserId = data.user!.id;

    const endpoint = await createEndpointForUser({
      userId: testUserId,
      name: "Stream Endpoint",
    });

    testEndpointId = endpoint.id;
    testEndpointSlug = endpoint.slug;
  });

  afterAll(async () => {
    if (testUserId) {
      await admin.auth.admin.deleteUser(testUserId);
    }
  });

  it("streams Supabase request inserts as SSE request events", async () => {
    const anonClient = createAnonClient();
    const signIn = await anonClient.auth.signInWithPassword({
      email: testUserEmail,
      password: TEST_PASSWORD,
    });

    expect(signIn.error).toBeNull();
    const accessToken = signIn.data.session!.access_token;

    const controller = new AbortController();
    const response = await streamRoute(
      authRequest(`/api/stream/${testEndpointSlug}`, accessToken, controller.signal),
      {
        params: Promise.resolve({ slug: testEndpointSlug }),
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const requestEventPromise = waitForEvent(response.body!, "request");

    const { error: insertError } = await admin.from("requests").insert({
      endpoint_id: testEndpointId,
      user_id: testUserId,
      method: "POST",
      path: "/stream-live",
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
      query_params: { from: "stream-test" },
      content_type: "application/json",
      ip: "127.0.0.1",
      size: 11,
    });

    expect(insertError).toBeNull();

    const frame = await requestEventPromise;
    const payload = JSON.parse(frame.data) as {
      _id: string;
      endpointId: string;
      method: string;
      path: string;
    };

    expect(payload).toMatchObject({
      _id: expect.any(String),
      endpointId: testEndpointId,
      method: "POST",
      path: "/stream-live",
    });

    controller.abort();
    await anonClient.auth.signOut();
  }, 20_000);
});
