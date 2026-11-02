import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { generateApiKey, hashApiKey } from "@/lib/supabase/api-keys";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { GET as listRoute } from "@/app/api/endpoints/route";
import { GET as getRoute } from "@/app/api/endpoints/[slug]/route";
import {
  DELETE as unfavoriteRoute,
  PUT as favoriteRoute,
} from "@/app/api/endpoints/[slug]/favorite/route";

/**
 * Favourite endpoints (migration 00079): each person's own, team members
 * included, idempotent both ways, reported on every read, never on an
 * endpoint the caller cannot open, and gone with the endpoint.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds: string[] = [];
const teamIds: string[] = [];

afterAll(async () => {
  for (const id of teamIds) await admin.from("teams").delete().eq("id", id);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

async function account(): Promise<{ userId: string; apiKey: string }> {
  const email = `test-endpoint-favorites-${Date.now()}-${userIds.length}@webhooks-test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  const userId = data.user!.id;
  userIds.push(userId);
  const apiKey = generateApiKey();
  const { error: keyError } = await admin.from("api_keys").insert({
    user_id: userId,
    key_hash: hashApiKey(apiKey),
    key_prefix: apiKey.slice(0, 12),
    name: "Endpoint favourites test",
  });
  if (keyError) throw keyError;
  return { userId, apiKey };
}

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const call = (apiKey: string, path: string, method = "GET") =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}` },
  });

async function favorite(apiKey: string, slug: string, on: boolean) {
  const path = `/api/endpoints/${slug}/favorite`;
  return on
    ? favoriteRoute(call(apiKey, path, "PUT"), params(slug))
    : unfavoriteRoute(call(apiKey, path, "DELETE"), params(slug));
}

async function listed(apiKey: string) {
  const response = await listRoute(call(apiKey, "/api/endpoints"));
  return (await response.json()) as {
    owned: { slug: string; favorite: boolean }[];
    shared: { slug: string; favorite: boolean }[];
  };
}

async function read(apiKey: string, slug: string) {
  const response = await getRoute(call(apiKey, `/api/endpoints/${slug}`), params(slug));
  return (await response.json()) as { favorite: boolean };
}

describe("endpoint favourites", () => {
  it("are marked and unmarked by the owner, idempotently, and reported on reads", async () => {
    const { userId, apiKey } = await account();
    const first = await createEndpointForUser({ userId, name: "First" });
    const second = await createEndpointForUser({ userId, name: "Second" });

    for (let i = 0; i < 2; i++) {
      const response = await favorite(apiKey, second.slug, true);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ favorite: true });
    }

    const { owned } = await listed(apiKey);
    expect(owned.find((ep) => ep.slug === second.slug)?.favorite).toBe(true);
    expect(owned.find((ep) => ep.slug === first.slug)?.favorite).toBe(false);
    expect((await read(apiKey, second.slug)).favorite).toBe(true);

    for (let i = 0; i < 2; i++) {
      const response = await favorite(apiKey, second.slug, false);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ favorite: false });
    }
    expect((await read(apiKey, second.slug)).favorite).toBe(false);
  });

  it("belong to each team member, and to no one who cannot open the endpoint", async () => {
    const owner = await account();
    const member = await account();
    const stranger = await account();
    const endpoint = await createEndpointForUser({ userId: owner.userId, name: "Shared" });

    expect((await favorite(stranger.apiKey, endpoint.slug, true)).status).toBe(404);
    expect((await favorite(stranger.apiKey, "no-such-endpoint", true)).status).toBe(404);

    const { data: team, error: teamError } = await admin
      .from("teams")
      .insert({
        name: `Favourites team ${Date.now()}`,
        created_by: owner.userId,
        subscription_status: "active",
        seats: 2,
        request_limit: 200_000,
        requests_used: 0,
        period_start: new Date().toISOString(),
        period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      })
      .select("id")
      .single();
    if (teamError) throw teamError;
    teamIds.push(team.id);
    const { error: membersError } = await admin.from("team_members").insert([
      { team_id: team.id, user_id: owner.userId, role: "owner" },
      { team_id: team.id, user_id: member.userId, role: "member" },
    ]);
    if (membersError) throw membersError;
    const { error: shareError } = await admin
      .from("team_endpoints")
      .insert({ team_id: team.id, endpoint_id: endpoint.id, shared_by: owner.userId });
    if (shareError) throw shareError;

    expect((await favorite(member.apiKey, endpoint.slug, true)).status).toBe(200);
    const asMember = await listed(member.apiKey);
    expect(asMember.shared.find((ep) => ep.slug === endpoint.slug)?.favorite).toBe(true);
    expect((await read(member.apiKey, endpoint.slug)).favorite).toBe(true);
    // The member's favourite is not the owner's.
    const asOwner = await listed(owner.apiKey);
    expect(asOwner.owned.find((ep) => ep.slug === endpoint.slug)?.favorite).toBe(false);
    expect((await read(owner.apiKey, endpoint.slug)).favorite).toBe(false);

    // Deleting the endpoint deletes every favourite of it.
    await admin.from("endpoints").delete().eq("id", endpoint.id);
    const { count } = await admin
      .from("endpoint_favorites")
      .select("endpoint_id", { count: "exact", head: true })
      .eq("endpoint_id", endpoint.id);
    expect(count).toBe(0);
  });
});
