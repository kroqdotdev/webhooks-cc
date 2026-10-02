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

async function collectEvents(
  stream: ReadableStream<Uint8Array>,
  expectedEvent: string,
  count: number
): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const collected: string[] = [];
  let buffer = "";
  const deadline = Date.now() + 15_000;

  try {
    while (collected.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const result = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (result === null || result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split("\n");
        if (lines.some((line) => line === `event: ${expectedEvent}`)) {
          const data = lines.find((line) => line.startsWith("data: "));
          if (data) collected.push(data.slice(6));
        }
      }
    }
    return collected;
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

  it("streams a burst of inserts once each, in order", async () => {
    const anonClient = createAnonClient();
    const signIn = await anonClient.auth.signInWithPassword({
      email: testUserEmail,
      password: TEST_PASSWORD,
    });
    expect(signIn.error).toBeNull();

    const controller = new AbortController();
    const response = await streamRoute(
      authRequest(
        `/api/stream/${testEndpointSlug}`,
        signIn.data.session!.access_token,
        controller.signal
      ),
      { params: Promise.resolve({ slug: testEndpointSlug }) }
    );
    expect(response.status).toBe(200);

    const burst = 30;
    const eventsPromise = collectEvents(response.body!, "request", burst);
    // Let the route subscribe before the burst, so it is served by signals
    // rather than only by the initial backlog read.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (let index = 0; index < burst; index++) {
      const { error } = await admin.from("requests").insert({
        endpoint_id: testEndpointId,
        user_id: testUserId,
        method: "POST",
        path: `/stream-burst/${index}`,
        headers: {},
        body: "{}",
        query_params: {},
        content_type: "application/json",
        ip: "127.0.0.1",
        size: 2,
      });
      expect(error).toBeNull();
    }

    const events = (await eventsPromise).map((data) => JSON.parse(data) as { path: string });
    expect(events.map((event) => event.path)).toEqual(
      Array.from({ length: burst }, (_, index) => `/stream-burst/${index}`)
    );

    controller.abort();
    await anonClient.auth.signOut();
  }, 30_000);

  it("streams every request when more than a page share one timestamp", async () => {
    // Rows tied on received_at, read by the initial backlog through the
    // (received_at, id) cursor. user_id is null so the rows send no broadcast
    // signals: 150 at once would trip the Realtime tenant's rate limit and
    // starve suites running alongside.
    const tied = 150;
    const receivedAt = new Date(Date.now() - 5_000).toISOString();
    const { error } = await admin.from("requests").insert(
      Array.from({ length: tied }, (_, index) => ({
        endpoint_id: testEndpointId,
        user_id: null,
        method: "POST",
        path: `/stream-tied/${index}`,
        headers: {},
        body: "{}",
        query_params: {},
        content_type: "application/json",
        ip: "127.0.0.1",
        size: 2,
        received_at: receivedAt,
      }))
    );
    expect(error).toBeNull();

    const anonClient = createAnonClient();
    const signIn = await anonClient.auth.signInWithPassword({
      email: testUserEmail,
      password: TEST_PASSWORD,
    });
    expect(signIn.error).toBeNull();

    const since = Date.parse(receivedAt) - 1;
    const controller = new AbortController();
    const response = await streamRoute(
      authRequest(
        `/api/stream/${testEndpointSlug}?since=${since}`,
        signIn.data.session!.access_token,
        controller.signal
      ),
      { params: Promise.resolve({ slug: testEndpointSlug }) }
    );
    expect(response.status).toBe(200);

    const paths = (await collectEvents(response.body!, "request", tied + 10))
      .map((data) => (JSON.parse(data) as { path: string }).path)
      .filter((path) => path.startsWith("/stream-tied/"));
    expect(paths).toHaveLength(tied);
    expect(new Set(paths).size).toBe(tied);

    controller.abort();
    await anonClient.auth.signOut();
  }, 30_000);

  it("streams endpoint_deleted and closes when the endpoint is deleted", async () => {
    const doomed = await createEndpointForUser({ userId: testUserId, name: "Doomed Stream" });
    const anonClient = createAnonClient();
    const signIn = await anonClient.auth.signInWithPassword({
      email: testUserEmail,
      password: TEST_PASSWORD,
    });
    expect(signIn.error).toBeNull();

    const controller = new AbortController();
    const response = await streamRoute(
      authRequest(
        `/api/stream/${doomed.slug}`,
        signIn.data.session!.access_token,
        controller.signal
      ),
      { params: Promise.resolve({ slug: doomed.slug }) }
    );
    expect(response.status).toBe(200);

    const deletedPromise = waitForEvent(response.body!, "endpoint_deleted");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { error } = await admin.from("endpoints").delete().eq("id", doomed.id);
    expect(error).toBeNull();

    const frame = await deletedPromise;
    expect(JSON.parse(frame.data)).toEqual({ slug: doomed.slug });

    controller.abort();
    await anonClient.auth.signOut();
  }, 20_000);

  it("streams bodyRaw for non-UTF-8 binary payloads via receiver", async () => {
    const anonClient = createAnonClient();
    const signIn = await anonClient.auth.signInWithPassword({
      email: testUserEmail,
      password: TEST_PASSWORD,
    });
    expect(signIn.error).toBeNull();
    const accessToken = signIn.data.session!.access_token;

    // Set user as pro with quota
    await admin
      .from("users")
      .update({
        plan: "pro",
        request_limit: 10000,
        requests_used: 0,
        period_end: new Date(Date.now() + 86400000).toISOString(),
      })
      .eq("id", testUserId);

    const controller = new AbortController();
    const response = await streamRoute(
      authRequest(`/api/stream/${testEndpointSlug}`, accessToken, controller.signal),
      { params: Promise.resolve({ slug: testEndpointSlug }) }
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const requestEventPromise = waitForEvent(response.body!, "request");

    // Send a binary payload through the actual receiver
    const binaryPayload = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x80, 0x81, 0x82, 0xff]);
    const receiverResp = await fetch(`http://localhost:3001/w/${testEndpointSlug}/stream-binary`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: binaryPayload,
    });
    expect(receiverResp.status).toBe(200);

    const frame = await requestEventPromise;
    const payload = JSON.parse(frame.data) as {
      _id: string;
      endpointId: string;
      method: string;
      path: string;
      body: string;
      bodyRaw?: string;
    };

    expect(payload.method).toBe("POST");
    expect(payload.path).toBe("/stream-binary");

    // body should be the lossy UTF-8 text
    expect(payload.body).toContain("Hello");

    // bodyRaw should be present and decode to exact original bytes
    expect(payload.bodyRaw).toBeDefined();
    const decoded = Buffer.from(payload.bodyRaw!, "base64");
    expect(decoded).toEqual(binaryPayload);

    controller.abort();
    await anonClient.auth.signOut();
  }, 20_000);

  it("streams UTF-8 requests without bodyRaw", async () => {
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
      { params: Promise.resolve({ slug: testEndpointSlug }) }
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const requestEventPromise = waitForEvent(response.body!, "request");

    // Send a normal UTF-8 JSON payload through the receiver
    const jsonBody = JSON.stringify({ event: "stream.test", data: { ok: true } });
    const receiverResp = await fetch(`http://localhost:3001/w/${testEndpointSlug}/stream-utf8`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: jsonBody,
    });
    expect(receiverResp.status).toBe(200);

    const frame = await requestEventPromise;
    const payload = JSON.parse(frame.data) as {
      _id: string;
      method: string;
      path: string;
      body: string;
      bodyRaw?: string;
    };

    expect(payload.method).toBe("POST");
    expect(payload.path).toBe("/stream-utf8");
    expect(payload.body).toBe(jsonBody);
    // UTF-8 payload: bodyRaw should be absent (null/undefined)
    expect(payload.bodyRaw).toBeFalsy();

    controller.abort();
    await anonClient.auth.signOut();
  }, 20_000);
});
