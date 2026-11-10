/**
 * What each request was answered with (migration 00090): the receiver records
 * the status it sent and the response rule that chose it on the request row,
 * and the request routes return them as responseStatus and responseRule.
 *
 * Needs the receiver running (make dev-receiver).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { listRequestsForEndpointByUser } from "@/lib/supabase/requests";

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

const RULES = [
  {
    id: "r1",
    name: "Payment failed",
    enabled: true,
    logic: "and",
    conditions: [{ field: "header", name: "x-event", op: "eq", value: "payment.failed" }],
    response: { status: 402, body: "declined", headers: {} },
  },
  {
    // No name: recorded by its place, as the dashboard numbers rules.
    id: "r2",
    enabled: true,
    logic: "and",
    conditions: [{ field: "method", op: "eq", value: "PUT" }],
    response: { status: 409, body: "", headers: {} },
  },
];

async function send(slug: string, init: { method?: string; headers?: Record<string, string> }) {
  const res = await fetch(`${RECEIVER_URL}/w/${slug}/hook`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: "{}",
  });
  await res.text();
  return res.status;
}

/** The newest request's recorded answer, once the row (and any correction) has landed. */
async function newestAnswer(endpointId: string) {
  // The receiver corrects a mispredicted row in the background, just after answering.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const { data, error } = await admin
    .from("requests")
    .select("response_status, response_rule")
    .eq("endpoint_id", endpointId)
    .order("received_at", { ascending: false })
    .limit(1)
    .single();
  expect(error).toBeNull();
  return data;
}

describe("Recorded answers", () => {
  let userId: string;
  let endpoint: { id: string; slug: string };

  beforeAll(async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: `test-answers-${Date.now()}@webhooks-test.local`,
      password: "TestPassword123!",
      email_confirm: true,
    });
    expect(error).toBeNull();
    userId = data.user!.id;
    await admin
      .from("users")
      .update({
        plan: "pro",
        request_limit: 10000,
        requests_used: 0,
        period_end: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .eq("id", userId);

    const created = await createEndpointForUser({ userId, name: "Answers" });
    endpoint = { id: created.id, slug: created.slug };
    const { error: updateError } = await admin
      .from("endpoints")
      .update({
        response_rules: RULES as unknown as Json,
        mock_response: { status: 202, body: "queued", headers: {} },
      })
      .eq("id", endpoint.id);
    expect(updateError).toBeNull();
  });

  afterAll(async () => {
    if (endpoint) {
      await admin.from("requests").delete().eq("endpoint_id", endpoint.id);
      await admin.from("endpoints").delete().eq("id", endpoint.id);
    }
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it("records the matching rule's status and name", async () => {
    expect(await send(endpoint.slug, { headers: { "x-event": "payment.failed" } })).toBe(402);
    expect(await newestAnswer(endpoint.id)).toEqual({
      response_status: 402,
      response_rule: "Payment failed",
    });
  });

  it("records an unnamed rule by its place", async () => {
    expect(await send(endpoint.slug, { method: "PUT" })).toBe(409);
    expect(await newestAnswer(endpoint.id)).toEqual({
      response_status: 409,
      response_rule: "Rule 2",
    });
  });

  it("records the endpoint's own response with no rule", async () => {
    expect(await send(endpoint.slug, {})).toBe(202);
    expect(await newestAnswer(endpoint.id)).toEqual({ response_status: 202, response_rule: null });
  });

  it("records what was sent after the rules change, not what they said before", async () => {
    // The receiver predicted from the rules it saw last; the edited rule answers differently.
    const edited = [{ ...RULES[0], response: { ...RULES[0].response, status: 418 } }, RULES[1]];
    await admin
      .from("endpoints")
      .update({ response_rules: edited as unknown as Json })
      .eq("id", endpoint.id);
    expect(await send(endpoint.slug, { headers: { "x-event": "payment.failed" } })).toBe(418);
    expect(await newestAnswer(endpoint.id)).toEqual({
      response_status: 418,
      response_rule: "Payment failed",
    });
  });

  it("records what a mock the receiver must fill in or replace actually sends", async () => {
    // Stored as an older partial PATCH left it: a status and nothing else.
    await admin
      .from("endpoints")
      .update({ response_rules: null, mock_response: { status: 418 } })
      .eq("id", endpoint.id);
    expect(await send(endpoint.slug, {})).toBe(418);
    expect(await newestAnswer(endpoint.id)).toEqual({ response_status: 418, response_rule: null });

    // A 1xx cannot end a response; the sender gets 500, and so does the record.
    await admin
      .from("endpoints")
      .update({ mock_response: { status: 102, body: "", headers: {} } })
      .eq("id", endpoint.id);
    expect(await send(endpoint.slug, {})).toBe(500);
    expect(await newestAnswer(endpoint.id)).toEqual({ response_status: 500, response_rule: null });

    await admin
      .from("endpoints")
      .update({ response_rules: RULES as unknown as Json, mock_response: null })
      .eq("id", endpoint.id);
  });

  it("returns the answers from the request routes", async () => {
    const records = await listRequestsForEndpointByUser({ userId, slug: endpoint.slug });
    const answers = (records ?? []).map((r) => [r.responseStatus, r.responseRule]);
    expect(answers).toEqual([
      [500, null],
      [418, null],
      [418, "Payment failed"],
      [202, null],
      [409, "Rule 2"],
      [402, "Payment failed"],
    ]);
  });
});
