import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";
import { cleanupExpiredEphemeralEndpoints } from "@/lib/supabase/cleanup";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// site_stats is not in the generated Database type yet (see app/page.tsx).
const stats = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function readDeletedWebhooks(): Promise<number> {
  const { data, error } = await stats
    .from("site_stats")
    .select("deleted_webhooks")
    .eq("id", 1)
    .single();

  if (error) throw error;
  return Number(data.deleted_webhooks);
}

// Other integration test files delete endpoints at the same time, so the delta
// is asserted as a band rather than an exact value: at least the count we
// deleted, and well under twice it (twice would mean the cleanup RPC and the
// trigger both counted the same rows). Concurrent tests contribute a few
// hundred at most, so a large marker count keeps the band unambiguous.
const COUNT = 100_000;

function expectCountedExactlyOnce(before: number, after: number) {
  const delta = after - before;
  expect(delta).toBeGreaterThanOrEqual(COUNT);
  expect(delta).toBeLessThan(2 * COUNT);
}

describe("Supabase site_stats deleted-webhook accounting (migration 00038)", () => {
  const endpointIds: string[] = [];
  let cascadeUserId: string | null = null;
  // The marker counts the tests add to deleted_webhooks are subtracted again
  // in afterAll so the dev database's landing-page total is not inflated.
  // Tracked as exactly COUNT per successful test (not the observed delta,
  // which can include concurrent test files' unrelated deletions).
  let accumulated = 0;

  afterAll(async () => {
    if (cascadeUserId) {
      await admin.auth.admin.deleteUser(cascadeUserId).catch(() => undefined);
    }
    if (endpointIds.length > 0) {
      // Leftovers only exist when a test failed before its delete. Zero their
      // counters first so this cleanup delete does not itself add marker
      // counts to deleted_webhooks that were never recorded in `accumulated`.
      await admin.from("endpoints").update({ request_count: 0 }).in("id", endpointIds);
      await admin.from("endpoints").delete().in("id", endpointIds);
    }
    if (accumulated > 0) {
      const current = await readDeletedWebhooks();
      const { error } = await stats
        .from("site_stats")
        .update({ deleted_webhooks: Math.max(0, current - accumulated) })
        .eq("id", 1);
      expect(error).toBeNull();
    }
  });

  it("counts webhooks of an endpoint deleted directly (the API delete path)", async () => {
    const id = randomUUID();
    endpointIds.push(id);

    const { error: insertError } = await admin.from("endpoints").insert({
      id,
      slug: `site-stats-direct-${Date.now()}`,
      is_ephemeral: false,
      request_count: COUNT,
    });
    expect(insertError).toBeNull();

    const before = await readDeletedWebhooks();

    const { error: deleteError } = await admin.from("endpoints").delete().eq("id", id);
    expect(deleteError).toBeNull();

    const after = await readDeletedWebhooks();
    expectCountedExactlyOnce(before, after);
    accumulated += COUNT;
  });

  it("counts expired ephemeral endpoints once when the cleanup RPC removes them", async () => {
    const id = randomUUID();
    endpointIds.push(id);

    const { error: insertError } = await admin.from("endpoints").insert({
      id,
      slug: `site-stats-ephemeral-${Date.now()}`,
      is_ephemeral: true,
      expires_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      request_count: COUNT,
    });
    expect(insertError).toBeNull();

    const before = await readDeletedWebhooks();

    const result = await cleanupExpiredEphemeralEndpoints();
    expect(result.deleted_endpoints).toBeGreaterThanOrEqual(1);

    const { data: remaining } = await admin.from("endpoints").select("id").eq("id", id);
    expect(remaining).toEqual([]);

    const after = await readDeletedWebhooks();
    expectCountedExactlyOnce(before, after);
    accumulated += COUNT;
  });

  it("counts endpoints removed by the account-deletion cascade", async () => {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: `site-stats-cascade-${Date.now()}@example.com`,
      password: `pw-${randomUUID()}`,
      email_confirm: true,
    });
    expect(createError).toBeNull();
    cascadeUserId = created.user!.id;

    const id = randomUUID();
    endpointIds.push(id);

    const { error: insertError } = await admin.from("endpoints").insert({
      id,
      slug: `site-stats-cascade-${Date.now()}`,
      user_id: cascadeUserId,
      is_ephemeral: false,
      request_count: COUNT,
    });
    expect(insertError).toBeNull();

    const before = await readDeletedWebhooks();

    // GoTrue deletes auth.users as its own role; the cascade reaches endpoints
    // and the trigger must still be allowed to write site_stats.
    const { error: deleteError } = await admin.auth.admin.deleteUser(cascadeUserId);
    expect(deleteError).toBeNull();
    cascadeUserId = null;

    const { data: remaining } = await admin.from("endpoints").select("id").eq("id", id);
    expect(remaining).toEqual([]);

    const after = await readDeletedWebhooks();
    expectCountedExactlyOnce(before, after);
    accumulated += COUNT;
  });
});
