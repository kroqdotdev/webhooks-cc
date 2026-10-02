import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { createTeam } from "@/lib/supabase/teams-crud";
import { shareEndpointWithTeam } from "@/lib/supabase/teams-endpoints";

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

async function signedInClient(email: string) {
  const client = createAnonClient();
  const { error } = await client.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  expect(error).toBeNull();
  return client;
}

async function createUser(prefix: string) {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@webhooks-test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  expect(error).toBeNull();
  return { id: data.user!.id, email };
}

// A refused join surfaces as CHANNEL_ERROR, or as TIMED_OUT while the client
// keeps retrying it; either way the channel never subscribes.
const REFUSED = /CHANNEL_ERROR|TIMED_OUT/;

type Signal = { event: string; payload: Record<string, unknown> };

/**
 * Joins a private broadcast topic and records its signals. Resolves once the
 * join is acknowledged; rejects with the join status if it is refused.
 */
async function listen(client: SupabaseClient<Database>, topic: string) {
  const signals: Signal[] = [];
  const waiters: Array<() => void> = [];
  const channel = client
    .channel(topic, { config: { private: true } })
    .on("broadcast", { event: "*" }, ({ event, payload }) => {
      signals.push({ event, payload: payload as Record<string, unknown> });
      for (const wake of waiters.splice(0)) wake();
    });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("TIMED_OUT")), 10_000);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timeout);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timeout);
        reject(new Error(status));
      }
    });
  });

  return {
    signals,
    /** Waits for the next signal with this event name. */
    async next(event: string, timeoutMs = 10_000): Promise<Signal> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = signals.findIndex((signal) => signal.event === event);
        if (index >= 0) return signals.splice(index, 1)[0]!;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Timed out waiting for ${event} on ${topic}`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    close: () => client.removeChannel(channel),
  };
}

function insertRequest(endpointId: string, userId: string, extra: Record<string, unknown> = {}) {
  return admin
    .from("requests")
    .insert({
      endpoint_id: endpointId,
      user_id: userId,
      method: "POST",
      path: "/realtime-test",
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
      query_params: {},
      content_type: "application/json",
      ip: "127.0.0.1",
      size: 11,
      ...extra,
    })
    .select("id")
    .single();
}

describe("Supabase Realtime broadcast topics", () => {
  let owner = { id: "", email: "" };
  let outsider = { id: "", email: "" };
  let endpointId = "";

  beforeAll(async () => {
    owner = await createUser("test-realtime-owner");
    outsider = await createUser("test-realtime-outsider");
    const endpoint = await createEndpointForUser({ userId: owner.id, name: "Realtime Endpoint" });
    endpointId = endpoint.id;
  });

  afterAll(async () => {
    if (endpointId) {
      await admin.from("requests").delete().eq("endpoint_id", endpointId);
      await admin.from("endpoints").delete().eq("id", endpointId);
    }
    for (const user of [owner, outsider]) {
      if (user.id) await admin.auth.admin.deleteUser(user.id);
    }
  });

  it("refuses topics to callers without a user", async () => {
    // The service role has no auth.uid(); it reaches topics by bypassing RLS,
    // not through this helper.
    const { data, error } = await admin.rpc(
      "can_join_realtime_topic" as never,
      {
        p_topic: `user:${owner.id}`,
      } as never
    );
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("signals request inserts and signature results to the owner", async () => {
    const client = await signedInClient(owner.email);
    const topic = await listen(client, `endpoint:${endpointId}`);

    const { data: inserted, error } = await insertRequest(endpointId, owner.id);
    expect(error).toBeNull();
    const created = await topic.next("request_created");
    expect(created.payload).toMatchObject({ request_id: inserted!.id });

    const { error: updateError } = await admin
      .from("requests")
      .update({ signature_verified: true, signing_provider: "stripe" })
      .eq("id", inserted!.id);
    expect(updateError).toBeNull();
    const updated = await topic.next("request_updated");
    expect(updated.payload).toMatchObject({ request_id: inserted!.id });

    await topic.close();
    await client.auth.signOut();
  }, 30_000);

  it("signals profile changes, but not a plain usage increment", async () => {
    const client = await signedInClient(owner.email);
    const topic = await listen(client, `user:${owner.id}`);

    await admin.from("users").update({ requests_used: 1 }).eq("id", owner.id);
    await expect(topic.next("profile_changed", 1500)).rejects.toThrow("Timed out");

    await admin.from("users").update({ subscription_status: "past_due" }).eq("id", owner.id);
    await topic.next("profile_changed");

    const { data: profile } = await admin
      .from("users")
      .select("request_limit")
      .eq("id", owner.id)
      .single();
    await admin.from("users").update({ requests_used: profile!.request_limit }).eq("id", owner.id);
    await topic.next("profile_changed");

    await topic.close();
    await client.auth.signOut();
  }, 30_000);

  it("signals endpoint deletion", async () => {
    const endpoint = await createEndpointForUser({ userId: owner.id, name: "Doomed Endpoint" });
    const client = await signedInClient(owner.email);
    const topic = await listen(client, `endpoint:${endpoint.id}`);

    await admin.from("endpoints").delete().eq("id", endpoint.id);
    const deleted = await topic.next("endpoint_deleted");
    expect(deleted.payload).toMatchObject({ endpoint_id: endpoint.id });

    await topic.close();
    await client.auth.signOut();
  }, 30_000);

  it("refuses other users' topics and anonymous clients", async () => {
    const outsiderClient = await signedInClient(outsider.email);
    await expect(listen(outsiderClient, `endpoint:${endpointId}`)).rejects.toThrow(REFUSED);
    await expect(listen(outsiderClient, `user:${owner.id}`)).rejects.toThrow(REFUSED);
    await expect(listen(outsiderClient, "endpoint:not-a-uuid")).rejects.toThrow(REFUSED);
    await outsiderClient.removeAllChannels();
    await outsiderClient.auth.signOut();

    const anonClient = createAnonClient();
    await expect(listen(anonClient, `endpoint:${endpointId}`)).rejects.toThrow(REFUSED);
    await anonClient.removeAllChannels();
  }, 40_000);

  it("signals request inserts on a team-shared endpoint to a team member", async () => {
    const member = await createUser("test-realtime-member");
    let teamId = "";
    try {
      const created = await createTeam(owner.id, "Realtime Team");
      if ("error" in created) throw new Error(created.error);
      teamId = created.id;

      // Active Teams subscription with a free seat (mirrors supabase-teams.test.ts).
      const { error: activateError } = await admin
        .from("teams")
        .update({
          subscription_status: "active",
          seats: 2,
          request_limit: 200_000,
          requests_used: 0,
          period_start: new Date().toISOString(),
          period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        })
        .eq("id", teamId);
      expect(activateError).toBeNull();

      const { error: memberInsertError } = await admin
        .from("team_members")
        .insert({ team_id: teamId, user_id: member.id, role: "member" });
      expect(memberInsertError).toBeNull();

      const share = await shareEndpointWithTeam(owner.id, teamId, endpointId);
      expect(share.success).toBe(true);

      const memberClient = await signedInClient(member.email);
      const topic = await listen(memberClient, `endpoint:${endpointId}`);

      // Rows carry the owner's user_id, as capture_webhook() writes them.
      const { data: inserted, error } = await insertRequest(endpointId, owner.id, {
        team_id: teamId,
      });
      expect(error).toBeNull();
      const signal = await topic.next("request_created");
      expect(signal.payload).toMatchObject({ request_id: inserted!.id });

      await topic.close();
      await memberClient.auth.signOut();
    } finally {
      if (teamId) {
        await admin.from("teams").delete().eq("id", teamId);
      }
      await admin.auth.admin.deleteUser(member.id);
    }
  }, 40_000);
});
