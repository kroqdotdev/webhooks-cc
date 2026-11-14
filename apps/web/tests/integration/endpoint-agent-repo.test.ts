import { createHash, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

/**
 * An endpoint's agent repository (migration 00103, lib/fix-prompt.ts): set,
 * normalised and cleared by the owner through the API, refused when it is not
 * GitHub's owner/name (by the route and by the database's check), and never
 * changed by a team member. Runs against a web server at WEB_URL.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");
const API_URL = process.env.WEB_URL ?? "http://localhost:3000";

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
  const email = `test-agent-repo-${Date.now()}-${userIds.length}@webhooks-test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  const userId = data.user!.id;
  userIds.push(userId);
  const apiKey = `whcc_${randomBytes(24).toString("hex")}`;
  const { error: keyError } = await admin.from("api_keys").insert({
    user_id: userId,
    key_hash: createHash("sha256").update(apiKey).digest("hex"),
    key_prefix: apiKey.slice(0, 12),
    name: "Agent repo test",
  });
  if (keyError) throw keyError;
  return { userId, apiKey };
}

function api(apiKey: string, method: string, path: string, body?: unknown) {
  return fetch(`${API_URL}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function stored(slug: string): Promise<string | null> {
  const { data, error } = await admin
    .from("endpoints")
    .select("agent_repo")
    .eq("slug", slug)
    .single<{ agent_repo: string | null }>();
  if (error) throw error;
  return data.agent_repo;
}

describe("endpoint agent repository", () => {
  it("is set, read back, normalised and cleared by the owner", async () => {
    const { apiKey } = await account();
    const created = await api(apiKey, "POST", "/endpoints", { name: "Agent repo" });
    expect(created.status).toBe(200);
    const { slug, agentRepo: initial } = (await created.json()) as {
      slug: string;
      agentRepo: string | null;
    };
    expect(initial).toBeNull();

    const set = await api(apiKey, "PATCH", `/endpoints/${slug}`, { agentRepo: "acme/api" });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { agentRepo: string }).agentRepo).toBe("acme/api");
    expect(await stored(slug)).toBe("acme/api");

    const read = await api(apiKey, "GET", `/endpoints/${slug}`);
    expect(((await read.json()) as { agentRepo: string }).agentRepo).toBe("acme/api");

    // Other settings leave it alone.
    await api(apiKey, "PATCH", `/endpoints/${slug}`, { name: "Renamed" });
    expect(await stored(slug)).toBe("acme/api");

    const normalised = await api(apiKey, "PATCH", `/endpoints/${slug}`, {
      agentRepo: " Acme-Inc/web.app.git ",
    });
    expect(((await normalised.json()) as { agentRepo: string }).agentRepo).toBe("Acme-Inc/web.app");

    for (const bad of ["acme", "https://github.com/acme/api", "-acme/api", "acme/..", 42]) {
      const refused = await api(apiKey, "PATCH", `/endpoints/${slug}`, { agentRepo: bad });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toMatch(/^agentRepo must be/);
    }
    expect(await stored(slug)).toBe("Acme-Inc/web.app");

    const cleared = await api(apiKey, "PATCH", `/endpoints/${slug}`, { agentRepo: null });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { agentRepo: string | null }).agentRepo).toBeNull();
    expect(await stored(slug)).toBeNull();

    await api(apiKey, "PATCH", `/endpoints/${slug}`, { agentRepo: "acme/api" });
    await api(apiKey, "PATCH", `/endpoints/${slug}`, { agentRepo: "" });
    expect(await stored(slug)).toBeNull();
  });

  it("is checked by the database too", async () => {
    const { apiKey } = await account();
    const created = await api(apiKey, "POST", "/endpoints", { name: "Agent repo check" });
    const { slug } = (await created.json()) as { slug: string };
    for (const bad of ["acme", "acme/api/x", "-acme/api", "acme/..", `${"a".repeat(40)}/b`]) {
      const { error } = await admin.from("endpoints").update({ agent_repo: bad }).eq("slug", slug);
      expect(error?.code).toBe("23514");
    }
    const { error } = await admin
      .from("endpoints")
      .update({ agent_repo: `${"a".repeat(39)}/${"b".repeat(100)}` })
      .eq("slug", slug);
    expect(error).toBeNull();
  });

  it("is changed by the owner only", async () => {
    const owner = await account();
    const member = await account();
    const created = await api(owner.apiKey, "POST", "/endpoints", { name: "Shared agent repo" });
    const { id, slug } = (await created.json()) as { id: string; slug: string };

    const { data: team, error: teamError } = await admin
      .from("teams")
      .insert({
        name: `Agent repo team ${Date.now()}`,
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
      .insert({ team_id: team.id, endpoint_id: id, shared_by: owner.userId });
    if (shareError) throw shareError;

    await api(owner.apiKey, "PATCH", `/endpoints/${slug}`, { agentRepo: "acme/api" });
    const refused = await api(member.apiKey, "PATCH", `/endpoints/${slug}`, {
      agentRepo: "intruder/repo",
    });
    expect(refused.status).toBe(403);
    expect(await stored(slug)).toBe("acme/api");

    // A member still sees it, so Open in T3 Code picks the project for them too.
    const read = await api(member.apiKey, "GET", `/endpoints/${slug}`);
    expect(((await read.json()) as { agentRepo: string }).agentRepo).toBe("acme/api");
  });
});
