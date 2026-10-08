import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { claimGuestEndpoint, createGuestEndpoint } from "@/lib/supabase/endpoints";

/**
 * Claiming a guest endpoint hands its earlier requests to the new owner
 * (migration 00053), so search and free-plan retention see them.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let userId: string;
let otherUserId: string;
const endpointIds: string[] = [];

async function createUser(label: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-guest-claim-${label}-${Date.now()}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  return data.user!.id;
}

async function insertRequest(endpointId: string, owner: string | null, path: string) {
  const { error } = await admin.from("requests").insert({
    endpoint_id: endpointId,
    user_id: owner,
    method: "POST",
    path,
    headers: { "content-type": "application/json" },
    body: '{"ok":true}',
    query_params: {},
    content_type: "application/json",
    ip: "127.0.0.1",
    size: 11,
    received_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function ownersOf(endpointId: string): Promise<(string | null)[]> {
  const { data, error } = await admin
    .from("requests")
    .select("user_id")
    .eq("endpoint_id", endpointId)
    .order("path");
  if (error) throw error;
  return (data ?? []).map((row) => row.user_id as string | null);
}

beforeAll(async () => {
  userId = await createUser("owner");
  otherUserId = await createUser("other");
});

afterAll(async () => {
  for (const id of endpointIds) {
    await admin.from("requests").delete().eq("endpoint_id", id);
    await admin.from("endpoints").delete().eq("id", id);
  }
  for (const id of [userId, otherUserId]) {
    if (id) await admin.auth.admin.deleteUser(id);
  }
});

describe("claiming a guest endpoint", () => {
  it("gives its earlier requests to the new owner", async () => {
    const guest = await createGuestEndpoint();
    endpointIds.push(guest.id);
    await insertRequest(guest.id, null, "/a");
    await insertRequest(guest.id, null, "/b");

    const claimed = await claimGuestEndpoint(userId, guest.slug);
    expect(claimed?.id).toBe(guest.id);
    expect(await ownersOf(guest.id)).toEqual([userId, userId]);
  });

  it("leaves requests that already have an owner alone", async () => {
    const guest = await createGuestEndpoint();
    endpointIds.push(guest.id);
    await insertRequest(guest.id, null, "/a");
    await insertRequest(guest.id, otherUserId, "/b");

    await claimGuestEndpoint(userId, guest.slug);
    expect(await ownersOf(guest.id)).toEqual([userId, otherUserId]);
  });

  it("does not touch requests when an owned endpoint is updated", async () => {
    const guest = await createGuestEndpoint();
    endpointIds.push(guest.id);
    await claimGuestEndpoint(userId, guest.slug);
    await insertRequest(guest.id, null, "/late");

    // Only a change from no owner to an owner hands requests over.
    await admin.from("endpoints").update({ name: "renamed" }).eq("id", guest.id);
    expect(await ownersOf(guest.id)).toEqual([null]);
  });
});
