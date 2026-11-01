import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { GET as listRoute, POST as createRoute } from "@/app/api/endpoints/route";
import { PATCH as updateRoute } from "@/app/api/endpoints/[slug]/route";
import { POST as guestRoute } from "@/app/api/go/endpoint/route";

/**
 * Where an endpoint is listed (migration 00078, lib/site.ts): the API keeps
 * `both` unless told otherwise, the dashboard sends its site, only the owner
 * changes it, and a guest endpoint takes the site it was made on. Plus the
 * GoTrue behaviour the header's site switch relies on (lib/site-switch.ts).
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
if (!ANON_KEY) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY env var required");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds: string[] = [];
const teamIds: string[] = [];
const guestSlugs: string[] = [];

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  if (guestSlugs.length > 0) await admin.from("endpoints").delete().in("slug", guestSlugs);
  for (const id of teamIds) await admin.from("teams").delete().eq("id", id);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

async function account(): Promise<{ userId: string; email: string; apiKey: string }> {
  const email = `test-endpoint-site-${Date.now()}-${userIds.length}@webhooks-test.local`;
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
    name: "Endpoint site test",
  });
  if (keyError) throw keyError;
  return { userId, email, apiKey };
}

function create(apiKey: string, body: Record<string, unknown>) {
  return createRoute(
    new Request("http://localhost/api/endpoints", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function update(apiKey: string, slug: string, body: Record<string, unknown>) {
  return updateRoute(
    new Request(`http://localhost/api/endpoints/${slug}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) }
  );
}

describe("endpoint site", () => {
  it("is both when the API leaves it out, and what it is told otherwise", async () => {
    const { apiKey } = await account();

    const plain = await create(apiKey, { name: "From the SDK" });
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as { site: string }).site).toBe("both");

    const mail = await create(apiKey, { name: "From mailhooks.cc", site: "mailhooks" });
    expect(mail.status).toBe(200);
    const created = (await mail.json()) as { slug: string; site: string };
    expect(created.site).toBe("mailhooks");

    expect((await create(apiKey, { site: "elsewhere" })).status).toBe(400);
    expect((await create(apiKey, { site: null })).status).toBe(400);

    const listed = await listRoute(
      new Request("http://localhost/api/endpoints", {
        headers: { authorization: `Bearer ${apiKey}` },
      })
    );
    const { owned } = (await listed.json()) as { owned: { slug: string; site: string }[] };
    expect(owned.find((endpoint) => endpoint.slug === created.slug)?.site).toBe("mailhooks");
  });

  it("is changed by the owner, never by a team member", async () => {
    const owner = await account();
    const member = await account();
    const endpoint = await createEndpointForUser({ userId: owner.userId, name: "Shared" });
    expect(endpoint.site).toBe("both");

    const moved = await update(owner.apiKey, endpoint.slug, { site: "webhooks" });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { site: string }).site).toBe("webhooks");
    expect((await update(owner.apiKey, endpoint.slug, { site: "all" })).status).toBe(400);

    const { data: team, error: teamError } = await admin
      .from("teams")
      .insert({
        name: `Site team ${Date.now()}`,
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

    // The member may rename it, not move it.
    expect((await update(member.apiKey, endpoint.slug, { name: "Renamed" })).status).toBe(200);
    expect((await update(member.apiKey, endpoint.slug, { site: "mailhooks" })).status).toBe(403);

    // The member's list carries the site the owner chose.
    const listed = await listRoute(
      new Request("http://localhost/api/endpoints", {
        headers: { authorization: `Bearer ${member.apiKey}` },
      })
    );
    const { shared } = (await listed.json()) as { shared: { slug: string; site: string }[] };
    expect(shared.find((item) => item.slug === endpoint.slug)?.site).toBe("webhooks");
  });

  it("lists a guest endpoint on the site it was made on", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "http://mailhooks.localhost:3210");
    const response = await guestRoute(
      new Request("http://localhost/api/go/endpoint", {
        method: "POST",
        headers: {
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
          "x-whk-site": "mailhooks",
          "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
        },
      })
    );
    expect(response.status).toBe(200);
    const guest = (await response.json()) as { slug: string; site: string };
    guestSlugs.push(guest.slug);
    expect(guest.site).toBe("mailhooks");
  });
});

describe("site switch sign-in tokens", () => {
  const client = () =>
    createClient(process.env.SUPABASE_URL!, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

  it("signs the same account in once, and only with the newest token", async () => {
    const { userId, email } = await account();
    const older = await admin.auth.admin.generateLink({ type: "magiclink", email });
    const newer = await admin.auth.admin.generateLink({ type: "magiclink", email });
    const olderHash = older.data.properties!.hashed_token;
    const newerHash = newer.data.properties!.hashed_token;

    const stale = await client().auth.verifyOtp({ type: "magiclink", token_hash: olderHash });
    expect(stale.error).not.toBeNull();

    const signedIn = await client().auth.verifyOtp({ type: "magiclink", token_hash: newerHash });
    expect(signedIn.error).toBeNull();
    expect(signedIn.data.user?.id).toBe(userId);
    expect(signedIn.data.session?.access_token).toBeTruthy();

    const replay = await client().auth.verifyOtp({ type: "magiclink", token_hash: newerHash });
    expect(replay.error).not.toBeNull();
  });
});
