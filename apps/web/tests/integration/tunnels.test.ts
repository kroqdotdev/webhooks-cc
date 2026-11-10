import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

/*
 * The tunnels control plane (lib/tunnels, app/api/edge/*, /api/shares,
 * /api/tunnel-names) against the dev stack. A small HTTP server stands in for
 * the edge's control port and records what the web app tells it.
 */

const EDGE_SECRET = "edge-secret-for-tests-0123456789abcdef";
process.env.EDGE_SECRET = EDGE_SECRET;
process.env.SHARE_PREVIEW_ORIGIN = "http://sharehooks.localhost:4000";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Route handlers as the tests call them; the context carries the params.
type Handler = (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Route = { POST?: Handler; GET?: Handler; PUT?: Handler; DELETE?: Handler };

let edgeCalls: { path: string; body: unknown }[] = [];
let fakeEdge: Server;
let routes: Record<string, Route>;
let hashApiKey: (key: string) => string;

const ts = Date.now();
let counter = 0;
const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];

async function createUser(fields: Record<string, unknown> = {}, confirmed = true) {
  counter += 1;
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-tunnels-${counter}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: confirmed,
  });
  if (error) throw error;
  const id = data.user!.id;
  createdUserIds.push(id);
  if (Object.keys(fields).length > 0) {
    const { error: updateError } = await admin.from("users").update(fields).eq("id", id);
    if (updateError) throw updateError;
  }
  const key = `whcc_tunnel_${ts}_${counter}_${Math.random().toString(36).slice(2, 10)}`;
  const { error: keyError } = await admin.from("api_keys").insert({
    user_id: id,
    key_hash: hashApiKey(key),
    key_prefix: key.slice(0, 12),
    name: "tunnel test key",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
  if (keyError) throw keyError;
  return { id, key };
}

function edge(path: string, body: unknown, secret = EDGE_SECRET) {
  return routes[path].POST!(
    new Request(`http://localhost/api/edge/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );
}

function api(
  route: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  key: string,
  opts: { url?: string; body?: unknown; params?: Record<string, string> } = {}
) {
  const handler = routes[route][method]!;
  return handler(
    new Request(opts.url ?? `http://localhost${route}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    { params: Promise.resolve(opts.params ?? {}) }
  );
}

async function open(key: string, extra: Record<string, unknown> = {}) {
  const res = await edge("open", {
    apiKey: key,
    client: "test-laptop, Linux",
    instance: `run-${Math.random().toString(36).slice(2)}`,
    address: "192.0.2.10",
    ...extra,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  fakeEdge = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      edgeCalls.push({ path: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/requests")
        res.end(
          JSON.stringify({
            activity: Object.fromEntries(
              ((body as { ids: string[] }).ids ?? []).map((id) => [
                id,
                {
                  requests: [
                    {
                      at: Date.parse("2026-11-10T12:00:00Z"),
                      method: "GET",
                      path: "/",
                      status: 200,
                      ms: 12,
                      bytes: 512,
                      country: "DK",
                      device: "computer",
                      visitor: 1,
                    },
                  ],
                  visitors: 1,
                  total: { requests: 1, bytes: 512 },
                },
              ])
            ),
          })
        );
      else res.end("{}");
    });
  });
  await new Promise<void>((resolve) => fakeEdge.listen(0, "127.0.0.1", resolve));
  process.env.EDGE_URL = `http://127.0.0.1:${(fakeEdge.address() as AddressInfo).port}`;

  ({ hashApiKey } = await import("@/lib/supabase/api-keys"));
  routes = {
    start: await import("@/app/api/edge/start/route"),
    open: await import("@/app/api/edge/open/route"),
    close: await import("@/app/api/edge/close/route"),
    sync: await import("@/app/api/edge/sync/route"),
    unlock: await import("@/app/api/edge/unlock/route"),
    flag: await import("@/app/api/edge/flag/route"),
    "/api/shares": await import("@/app/api/shares/route"),
    "/api/shares/stop": await import("@/app/api/shares/[id]/stop/route"),
    "/api/shares/requests": await import("@/app/api/shares/[id]/requests/route"),
    "/api/tunnel-names": await import("@/app/api/tunnel-names/route"),
    "/api/tunnel-names/name": await import("@/app/api/tunnel-names/[name]/route"),
    "/api/tunnel-names/password": await import("@/app/api/tunnel-names/[name]/password/route"),
  } as unknown as Record<string, Route>;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fakeEdge.close(() => resolve()));
  for (const id of createdTeamIds) await admin.from("teams").delete().eq("id", id);
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

describe("edge routes", () => {
  it("answer 404 to anyone without the edge's secret", async () => {
    expect((await edge("open", {}, "wrong-secret")).status).toBe(404);
    expect((await edge("sync", {}, "")).status).toBe(404);
  });

  it("refuse keys that do not work, unconfirmed emails and pre-claim agent tokens", async () => {
    expect((await open("whcc_nonsense")).status).toBe(401);
    expect((await open("not-a-key")).status).toBe(401);

    const unconfirmed = await createUser({}, false);
    const refused = await open(unconfirmed.key);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Confirm your email/);

    const agentKey = `whcc_agent_${ts}_${Math.random().toString(36).slice(2, 10)}`;
    const { error } = await admin.from("api_keys").insert({
      user_id: null,
      key_hash: hashApiKey(agentKey),
      key_prefix: agentKey.slice(0, 12),
      name: "pre-claim agent",
      is_agent_issued: true,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(error).toBeNull();
    expect((await open(agentKey)).status).toBe(403);

    const suspended = await createUser({ tunnels_suspended: true });
    const off = await open(suspended.key);
    expect(off.status).toBe(403);
    expect(off.body.error).toMatch(/suspended/);
  });

  it("gives Free one random -free preview for two hours, behind the notice", async () => {
    const free = await createUser();
    const first = await open(free.key);
    expect(first.status).toBe(200);
    expect(first.body.name).toMatch(/^[a-z]+-[a-z]+-\d{4}-free$/);
    expect(first.body.url).toBe(`http://${first.body.name}.sharehooks.localhost:4000`);
    expect(first.body.notice).toBe(true);
    expect(first.body.plan).toBe("free");
    expect(first.body.gate).toBeNull();
    expect(first.body.userId).toBe(free.id);
    expect(first.body.expiresIn).toBeGreaterThan(7_100);
    expect(first.body.expiresIn).toBeLessThanOrEqual(7_200);

    const second = await open(free.key);
    expect(second.status).toBe(429);
    expect(second.body.error).toMatch(/Free allows 1 live share/);

    expect((await open(free.key, { name: "nordic-bakery" })).body.error).toMatch(/random name/);
    expect((await open(free.key, { password: "long enough pw" })).status).toBe(403);

    expect((await edge("close", { shareId: first.body.shareId, reason: "closed" })).status).toBe(
      200
    );
    expect((await open(free.key)).status).toBe(200);
  });

  it("keeps a random name across a reconnect of the same run", async () => {
    const user = await createUser();
    const first = await open(user.key, { instance: "same-run-1" });
    await edge("close", { shareId: first.body.shareId, reason: "closed" });
    const again = await open(user.key, { instance: "same-run-1" });
    expect(again.status).toBe(200);
    expect(again.body.name).toBe(first.body.name);
  });

  it("lets Pro keep names, put passwords on them, and lifts the notice after a week", async () => {
    const pro = await createUser({ plan: "pro", request_limit: 100_000 });
    const name = `nordic-${counter}-${ts % 100_000}`;

    const reserved = await api("/api/tunnel-names", "POST", pro.key, { body: { name } });
    expect(reserved.status).toBe(201);
    expect(((await reserved.json()) as { name: { name: string; url: string } }).name).toMatchObject(
      {
        name,
        url: `http://${name}.sharehooks.localhost:4000`,
      }
    );
    expect(
      (await api("/api/tunnel-names", "POST", pro.key, { body: { name: "paypal-login" } })).status
    ).toBe(403);
    expect(
      (await api("/api/tunnel-names", "POST", pro.key, { body: { name: "bakery-free" } })).status
    ).toBe(400);

    // Paid since today: the notice shows for the first week.
    const fresh = await open(pro.key, { name });
    expect(fresh.status).toBe(200);
    expect(fresh.body.name).toBe(name);
    expect(fresh.body.notice).toBe(true);
    expect(fresh.body.expiresIn).toBeNull();
    await edge("close", { shareId: fresh.body.shareId, reason: "closed" });

    await admin
      .from("users")
      .update({ paid_since: new Date(Date.now() - 8 * 86_400_000).toISOString() })
      .eq("id", pro.id);
    const settled = await open(pro.key, { name, password: "visitors-only-1" });
    expect(settled.body.notice).toBe(false);
    expect(typeof settled.body.gate).toBe("string");

    const wrong = await edge("unlock", { shareId: settled.body.shareId, password: "nope-nope" });
    expect(await wrong.json()).toEqual({ ok: false });
    const right = await edge("unlock", {
      shareId: settled.body.shareId,
      password: "visitors-only-1",
    });
    expect(await right.json()).toEqual({ ok: true, version: settled.body.gate });

    // The same password on a reconnect keeps the version, so visitors stay in.
    await edge("close", { shareId: settled.body.shareId, reason: "closed" });
    const reconnect = await open(pro.key, { name, password: "visitors-only-1" });
    expect(reconnect.body.gate).toBe(settled.body.gate);
    await edge("close", { shareId: reconnect.body.shareId, reason: "closed" });

    // A name's password holds for previews without their own, and reaches the edge.
    const plain = await open(pro.key, { name });
    expect(plain.body.gate).toBeNull();
    edgeCalls = [];
    const set = await api("/api/tunnel-names/password", "PUT", pro.key, {
      body: { password: "name-wide-secret" },
      params: { name },
    });
    expect(await set.json()).toEqual({ ok: true, password: true });
    const gateCall = edgeCalls.find((c) => c.path === "/gate");
    expect(gateCall?.body).toEqual({
      gates: [{ shareId: plain.body.shareId, gate: expect.any(String) }],
    });
    const synced = (await (await edge("sync", { shareIds: [plain.body.shareId] })).json()) as {
      gates: { shareId: string; gate: string }[];
    };
    expect(synced.gates[0].gate).toBe(
      (gateCall!.body as { gates: { gate: string }[] }).gates[0].gate
    );

    const listed = (await (await api("/api/tunnel-names", "GET", pro.key)).json()) as {
      names: { name: string; password: boolean; live: boolean; mine: boolean }[];
      limit: number;
      used: number;
    };
    expect(listed.limit).toBe(3);
    expect(listed.used).toBe(1);
    expect(listed.names[0]).toMatchObject({ name, password: true, live: true, mine: true });

    const cleared = await api("/api/tunnel-names/password", "DELETE", pro.key, {
      params: { name },
    });
    expect(await cleared.json()).toEqual({ ok: true, password: false });

    expect(
      (await api("/api/tunnel-names/name", "DELETE", pro.key, { params: { name } })).status
    ).toBe(200);
  });

  it("counts each usage batch once, and pauses accounts past their data", async () => {
    const free = await createUser();
    const opened = await open(free.key);
    const shareId = opened.body.shareId as string;
    const batch = {
      id: `batch-${ts}-${counter}`,
      usage: [{ id: shareId, kind: "share", bytes: 600 * 1024 ** 2, requests: 10 }],
    };
    await edge("sync", { shareIds: [shareId], batches: [batch] });
    const again = (await (
      await edge("sync", { shareIds: [shareId], batches: [batch] })
    ).json()) as {
      over: string[];
    };
    expect(again.over).not.toContain(free.id);
    const { data: share } = await admin
      .from("tunnel_shares")
      .select("bytes, requests")
      .eq("id", shareId)
      .single();
    expect(share).toEqual({ bytes: 600 * 1024 ** 2, requests: 10 });

    const more = { ...batch, id: `${batch.id}-2` };
    const over = (await (await edge("sync", { shareIds: [shareId], batches: [more] })).json()) as {
      over: string[];
    };
    expect(over.over).toContain(free.id);

    await edge("close", { shareId, reason: "closed" });
    const refused = await open(free.key);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatch(/paused/);

    const listed = (await (await api("/api/shares", "GET", free.key)).json()) as {
      usage: { bytes: number; over: boolean; limitBytes: number };
      limits: { plan: string; shares: number; dataGb: number; notice: boolean };
    };
    expect(listed.usage).toMatchObject({
      bytes: 1200 * 1024 ** 2,
      over: true,
      limitBytes: 1024 ** 3,
    });
    expect(listed.limits).toMatchObject({ plan: "free", shares: 1, dataGb: 1, notice: true });
  });

  it("stops a share from the API, tells the edge, and keeps the run from coming back", async () => {
    const user = await createUser();
    const opened = await open(user.key, { instance: "stoppable-run" });
    const shareId = opened.body.shareId as string;

    const requests = (await (
      await api("/api/shares/requests", "GET", user.key, { params: { id: shareId } })
    ).json()) as { available: boolean; requests: { path: string; at: string }[] };
    expect(requests.available).toBe(true);
    expect(requests.requests[0]).toMatchObject({ path: "/", at: "2026-11-10T12:00:00.000Z" });

    edgeCalls = [];
    const stop = await api("/api/shares/stop", "POST", user.key, { params: { id: shareId } });
    expect(stop.status).toBe(200);
    expect(edgeCalls.find((c) => c.path === "/close")?.body).toEqual({
      closes: [{ shareId, reason: expect.stringMatching(/through the webhooks.cc API/) }],
    });

    const synced = (await (await edge("sync", { shareIds: [shareId] })).json()) as {
      close: { shareId: string; reason: string }[];
    };
    expect(synced.close).toEqual([{ shareId, reason: expect.stringMatching(/API/) }]);

    const back = await open(user.key, { instance: "stoppable-run" });
    expect(back.status).toBe(410);

    const other = await createUser();
    expect(
      (await api("/api/shares/stop", "POST", other.key, { params: { id: shareId } })).status
    ).toBe(404);

    const listed = (await (
      await api("/api/shares", "GET", user.key, {
        url: "http://localhost/api/shares?state=ended",
      })
    ).json()) as { shares: { id: string; endedAt: string | null; endReason: string }[] };
    expect(listed.shares.find((s) => s.id === shareId)).toMatchObject({
      endReason: "stopped through the API",
    });
  });

  it("ends runs past their time at the next sync", async () => {
    const user = await createUser();
    const opened = await open(user.key);
    const shareId = opened.body.shareId as string;
    const { error } = await admin
      .from("tunnel_shares")
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() } as never)
      .eq("id", shareId);
    expect(error).toBeNull();
    const synced = (await (await edge("sync", { shareIds: [shareId] })).json()) as {
      close: { shareId: string; reason: string }[];
    };
    expect(synced.close).toEqual([{ shareId, reason: "it reached the plan's time limit" }]);
    // A run that reached its time may not come back by reconnecting.
    const { data } = await admin
      .from("tunnel_shares")
      .select("instance")
      .eq("id", shareId)
      .single();
    expect((await open(user.key, { instance: data!.instance })).status).toBe(410);
  });

  it("opens a live session on the account's own endpoint and clears it on close", async () => {
    const user = await createUser();
    const slug = `tun-${ts % 1_000_000}-${counter}`;
    const { data: endpoint, error } = await admin
      .from("endpoints")
      .insert({ user_id: user.id, slug, name: "live" })
      .select("id")
      .single();
    if (error) throw error;

    const live = await open(user.key, { kind: "live", endpoint: slug });
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({
      name: slug,
      url: expect.stringMatching(new RegExp(`/w/${slug}$`)),
      notice: false,
      gate: null,
      expiresIn: null,
      endpointId: endpoint.id,
    });
    const { data: marked } = await admin
      .from("endpoints")
      .select("live_session_id")
      .eq("id", endpoint.id)
      .single();
    expect(marked?.live_session_id).toBe(live.body.shareId);

    // A live session does not take the account's one preview slot.
    expect((await open(user.key)).status).toBe(200);

    const stranger = await createUser();
    expect((await open(stranger.key, { kind: "live", endpoint: slug })).status).toBe(404);

    await edge("close", { shareId: live.body.shareId, reason: "closed" });
    const { data: cleared } = await admin
      .from("endpoints")
      .select("live_session_id")
      .eq("id", endpoint.id)
      .single();
    expect(cleared?.live_session_id).toBeNull();
  });

  it("records a phishing flag once per run", async () => {
    const user = await createUser();
    const opened = await open(user.key);
    const shareId = opened.body.shareId as string;
    const flag = { shareId, url: `${opened.body.url}/login`, signals: ["a password field"] };
    expect(await (await edge("flag", flag)).json()).toEqual({ ok: true, flagged: true });
    expect(await (await edge("flag", flag)).json()).toEqual({ ok: true, flagged: false });
    const { data } = await admin
      .from("abuse_reports")
      .select("source, kind, user_id, name")
      .eq("share_id", shareId);
    expect(data).toEqual([
      { source: "flag", kind: "phishing", user_id: user.id, name: opened.body.name },
    ]);
  });

  it("gives a team's names to every member and lets a member stop a teammate's preview", async () => {
    const owner = await createUser({ plan: "pro", request_limit: 100_000 });
    const member = await createUser();
    const { data: team, error } = await admin
      .from("teams")
      .insert({ name: "Acme team", created_by: owner.id, subscription_status: "active", seats: 2 })
      .select("id")
      .single();
    if (error) throw error;
    createdTeamIds.push(team.id);
    await admin.from("team_members").insert([
      { team_id: team.id, user_id: owner.id, role: "owner" },
      { team_id: team.id, user_id: member.id, role: "member" },
    ]);

    // The member is on Free, but the team's live subscription gives Teams.
    const plan = (await (await api("/api/shares", "GET", member.key)).json()) as {
      limits: { plan: string; shares: number; notice: boolean };
    };
    expect(plan.limits).toMatchObject({ plan: "team", shares: 3, notice: true });

    const name = `acme-team-${ts % 100_000}`;
    expect(
      (await api("/api/tunnel-names", "POST", owner.key, { body: { name, team: team.id } })).status
    ).toBe(201);
    const shared = await open(member.key, { name });
    expect(shared.status).toBe(200);
    expect(shared.body.name).toBe(name);

    const busy = await open(owner.key, { name });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatch(/is sharing under/);

    const ownerView = (await (
      await api("/api/shares", "GET", owner.key, {
        url: "http://localhost/api/shares?state=live",
      })
    ).json()) as { shares: { id: string; mine: boolean }[] };
    expect(ownerView.shares).toContainEqual(
      expect.objectContaining({ id: shared.body.shareId, mine: false })
    );
    const stop = await api("/api/shares/stop", "POST", owner.key, {
      params: { id: shared.body.shareId as string },
    });
    expect(stop.status).toBe(200);
    const { data: row } = await admin
      .from("tunnel_shares")
      .select("end_reason")
      .eq("id", shared.body.shareId as string)
      .single();
    expect(row?.end_reason).toBe("stopped by the team");

    // A member may not release a team name; the owner may.
    expect(
      (await api("/api/tunnel-names/name", "DELETE", member.key, { params: { name } })).status
    ).toBe(404);
    expect(
      (await api("/api/tunnel-names/name", "DELETE", owner.key, { params: { name } })).status
    ).toBe(200);
  });

  it("never lets a run outlive the access it was opened with", async () => {
    const { unshareEndpointFromTeam } = await import("@/lib/supabase/teams-endpoints");
    const { revokeConnectedAgent } = await import("@/lib/agent/claims");
    const owner = await createUser({ plan: "pro", request_limit: 100_000 });
    const member = await createUser();
    const { data: team, error } = await admin
      .from("teams")
      .insert({ name: "Access team", created_by: owner.id, subscription_status: null, seats: 2 })
      .select("id")
      .single();
    if (error) throw error;
    createdTeamIds.push(team.id);
    await admin.from("team_members").insert([
      { team_id: team.id, user_id: owner.id, role: "owner" },
      { team_id: team.id, user_id: member.id, role: "member" },
    ]);
    const slug = `acc${ts % 1_000_000}`;
    const { data: endpoint, error: epError } = await admin
      .from("endpoints")
      .insert({ user_id: owner.id, slug, name: "shared" })
      .select("id")
      .single();
    if (epError) throw epError;
    await admin
      .from("team_endpoints")
      .insert({ team_id: team.id, endpoint_id: endpoint.id, shared_by: owner.id });

    // A lapsed team gives its members none of its shared endpoints.
    expect((await open(member.key, { kind: "live", endpoint: slug })).status).toBe(404);

    // Subscribed again: the member may relay it, until the owner unshares it.
    await admin.from("teams").update({ subscription_status: "active" }).eq("id", team.id);
    const live = await open(member.key, { kind: "live", endpoint: slug });
    expect(live.status).toBe(200);
    edgeCalls = [];
    expect(await unshareEndpointFromTeam(owner.id, team.id, endpoint.id)).toBe(true);
    const { data: unshared } = await admin
      .from("tunnel_shares")
      .select("ended_at, end_reason")
      .eq("id", live.body.shareId as string)
      .single();
    expect(unshared?.end_reason).toBe("access ended");
    // Other suites' runs may close in the same call: look for this one.
    const closed = edgeCalls
      .filter((c) => c.path === "/close")
      .flatMap((c) => (c.body as { closes: { shareId: string; reason: string }[] }).closes);
    expect(closed).toContainEqual({
      shareId: live.body.shareId,
      reason: expect.stringMatching(/access it was opened with has ended/),
    });

    // A preview under the team's name ends at the next sync once the member is
    // gone, even when the removal never reached the edge itself.
    const name = `acme-crew-${ts % 100_000}`;
    expect(
      (await api("/api/tunnel-names", "POST", owner.key, { body: { name, team: team.id } })).status
    ).toBe(201);
    const preview = await open(member.key, { name });
    expect(preview.status).toBe(200);
    await admin.from("team_members").delete().eq("team_id", team.id).eq("user_id", member.id);
    const synced = (await (
      await edge("sync", { shareIds: [preview.body.shareId], batches: [] })
    ).json()) as { close: { shareId: string; reason: string }[] };
    expect(synced.close).toContainEqual({
      shareId: preview.body.shareId,
      reason: expect.stringMatching(/access it was opened with has ended/),
    });

    // An agent's run lives while its registration does, through token expiry,
    // and ends when the human disconnects the agent.
    const { data: registration, error: regError } = await admin
      .from("agent_registrations")
      .insert({
        kind: "service_auth",
        user_id: member.id,
        claimed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .select("id")
      .single();
    if (regError) throw regError;
    const agentKey = `whcc_agent_access_${ts}_${Math.random().toString(36).slice(2, 10)}`;
    const { data: keyRow, error: keyError } = await admin
      .from("api_keys")
      .insert({
        user_id: member.id,
        key_hash: hashApiKey(agentKey),
        key_prefix: agentKey.slice(0, 12),
        name: "agent access token",
        is_agent_issued: true,
        agent_registration_id: registration.id,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .select("id")
      .single();
    if (keyError) throw keyError;
    const agentRun = await open(agentKey);
    expect(agentRun.status).toBe(200);
    // The access token expires and is cleaned up: the run carries on.
    await admin.from("api_keys").delete().eq("id", keyRow.id);
    await edge("sync", { shareIds: [agentRun.body.shareId], batches: [] });
    const { data: still } = await admin
      .from("tunnel_shares")
      .select("ended_at")
      .eq("id", agentRun.body.shareId as string)
      .single();
    expect(still?.ended_at).toBeNull();
    expect(await revokeConnectedAgent(member.id, registration.id)).toBe(true);
    const { data: revoked } = await admin
      .from("tunnel_shares")
      .select("end_reason")
      .eq("id", agentRun.body.shareId as string)
      .single();
    expect(revoked?.end_reason).toBe("access ended");
  });

  it("keeps a deleted account's runs for the evidence, and ends them", async () => {
    const user = await createUser();
    const opened = await open(user.key);
    expect(opened.status).toBe(200);
    await admin.auth.admin.deleteUser(user.id);
    const { data: kept } = await admin
      .from("tunnel_shares")
      .select("user_id, client_address, ended_at")
      .eq("id", opened.body.shareId as string)
      .single();
    expect(kept).toMatchObject({ user_id: null, client_address: "192.0.2.10", ended_at: null });
    const synced = (await (
      await edge("sync", { shareIds: [opened.body.shareId], batches: [] })
    ).json()) as { close: { shareId: string; reason: string }[] };
    expect(synced.close).toContainEqual({
      shareId: opened.body.shareId,
      reason: "the account was deleted",
    });
    const { data: ended } = await admin
      .from("tunnel_shares")
      .select("end_reason, client_address")
      .eq("id", opened.body.shareId as string)
      .single();
    expect(ended).toMatchObject({ end_reason: "account deleted", client_address: "192.0.2.10" });
    await admin
      .from("tunnel_shares")
      .delete()
      .eq("id", opened.body.shareId as string);
  });

  it("refuses names shaped like random ones, and name changes while suspended", async () => {
    const pro = await createUser({ plan: "pro", request_limit: 100_000 });
    for (const drawn of ["amber-badger-0042", "amber-badger-0042-free"]) {
      const res = await api("/api/tunnel-names", "POST", pro.key, { body: { name: drawn } });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    const drawnRes = await api("/api/tunnel-names", "POST", pro.key, {
      body: { name: "amber-badger-0042" },
    });
    expect(((await drawnRes.json()) as { error: string }).error).toMatch(/drawn at random/);

    const name = `kept-before-${ts % 100_000}`;
    expect((await api("/api/tunnel-names", "POST", pro.key, { body: { name } })).status).toBe(201);
    await admin.from("users").update({ tunnels_suspended: true }).eq("id", pro.id);
    const reserve = await api("/api/tunnel-names", "POST", pro.key, {
      body: { name: `kept-after-${ts % 100_000}` },
    });
    expect(reserve.status).toBe(403);
    expect(((await reserve.json()) as { error: string }).error).toMatch(/suspended/);
    const password = await api("/api/tunnel-names/password", "PUT", pro.key, {
      body: { password: "correct-horse" },
      params: { name },
    });
    expect(password.status).toBe(403);
    // Letting a name go is still allowed.
    expect(
      (await api("/api/tunnel-names/name", "DELETE", pro.key, { params: { name } })).status
    ).toBe(200);
  });

  it("never hands back a blocked free name on a reconnect", async () => {
    const { randomNameFree } = await import("@/lib/tunnels/names");
    const user = await createUser();
    const name = `amber-badger-${String(ts % 10_000).padStart(4, "0")}-free`;
    expect(await randomNameFree(user.id, name, true)).toBe(true);
    await admin.from("tunnel_blocked_names").insert({ name });
    try {
      expect(await randomNameFree(user.id, name, true)).toBe(false);
    } finally {
      await admin.from("tunnel_blocked_names").delete().eq("name", name);
    }
  });

  it("closes the report form in production when a Turnstile key is missing", async () => {
    const report = await import("@/app/api/report/route");
    vi.stubEnv("NODE_ENV", "production");
    try {
      const res = await report.POST(
        new Request("http://localhost/api/report", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "http://acme.sharehooks.localhost:4000/" }),
        })
      );
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toMatch(/support@webhooks.cc/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("closes every open run when the edge restarts", async () => {
    const user = await createUser();
    const opened = await open(user.key);
    const res = (await (await edge("start", {})).json()) as { ok: boolean; closed: number };
    expect(res.ok).toBe(true);
    expect(res.closed).toBeGreaterThanOrEqual(1);
    const { data } = await admin
      .from("tunnel_shares")
      .select("end_reason")
      .eq("id", opened.body.shareId as string)
      .single();
    expect(data?.end_reason).toBe("edge restart");
  });
});
