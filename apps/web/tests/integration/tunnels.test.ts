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
    const run = "run-pro-password";
    const settled = await open(pro.key, { name, password: "visitors-only-1", instance: run });
    expect(settled.body.notice).toBe(false);
    expect(typeof settled.body.gate).toBe("string");

    const wrong = await edge("unlock", { shareId: settled.body.shareId, password: "nope-nope" });
    expect(await wrong.json()).toEqual({ ok: false });
    const right = await edge("unlock", {
      shareId: settled.body.shareId,
      password: "visitors-only-1",
    });
    expect(await right.json()).toEqual({ ok: true, version: settled.body.gate });

    // A reconnect of the same run keeps the version, so visitors stay in.
    await edge("close", { shareId: settled.body.shareId, reason: "closed" });
    const reconnect = await open(pro.key, { name, password: "visitors-only-1", instance: run });
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
      closes: [
        { shareId, reason: expect.stringMatching(/whk shares stop, the Shares page or the API/) },
      ],
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
      endReason: "stopped with whk shares stop or the API",
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

    // A member may not release a team name (told who may); the owner may.
    const refused = await api("/api/tunnel-names/name", "DELETE", member.key, { params: { name } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toMatch(/team's owner/);
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

  it("gives an agent token everything the Shares page shows, with next steps as commands", async () => {
    const user = await createUser({
      plan: "pro",
      request_limit: 100_000,
      paid_since: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });
    const { data: registration, error: regError } = await admin
      .from("agent_registrations")
      .insert({
        kind: "service_auth",
        user_id: user.id,
        claimed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .select("id")
      .single();
    if (regError) throw regError;
    const agentKey = `whcc_agent_access_${ts}_${Math.random().toString(36).slice(2, 10)}`;
    const { error: keyError } = await admin.from("api_keys").insert({
      user_id: user.id,
      key_hash: hashApiKey(agentKey),
      key_prefix: agentKey.slice(0, 12),
      name: "agent access token",
      is_agent_issued: true,
      agent_registration_id: registration.id,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    if (keyError) throw keyError;

    const name = `agent-made-${ts % 100_000}`;
    expect((await api("/api/tunnel-names", "POST", agentKey, { body: { name } })).status).toBe(201);
    const opened = await open(agentKey, { name });
    expect(opened.status).toBe(200);

    const listing = (await (await api("/api/shares", "GET", agentKey)).json()) as {
      shares: { id: string; notice: boolean }[];
      limits: { plan: string; label: string };
      usage: { message: string | null };
      names: { limit: number; used: number; usable: number };
      suspended: boolean;
      hints: string[];
    };
    expect(listing.shares).toContainEqual(
      expect.objectContaining({ id: opened.body.shareId, notice: false })
    );
    expect(listing.limits).toMatchObject({ plan: "pro", label: "Pro" });
    expect(listing.usage.message).toBeNull();
    expect(listing.names).toEqual({ limit: 3, used: 1, usable: 1 });
    expect(listing.suspended).toBe(false);
    expect(listing.hints.join("\n")).toMatch(/whk share <port>/);
    expect(listing.hints.join("\n")).toMatch(/whk tunnel <port> --live/);

    const requests = await api("/api/shares/requests", "GET", agentKey, {
      params: { id: opened.body.shareId as string },
    });
    expect(requests.status).toBe(200);
    expect(
      (
        await api("/api/tunnel-names/password", "PUT", agentKey, {
          params: { name },
          body: { password: "correct-horse-1" },
        })
      ).status
    ).toBe(200);
    const stop = await api("/api/shares/stop", "POST", agentKey, {
      params: { id: opened.body.shareId as string },
    });
    expect(stop.status).toBe(200);
    expect(
      (await api("/api/tunnel-names/name", "DELETE", agentKey, { params: { name } })).status
    ).toBe(200);
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

describe("round two: limits, names and access while runs are open", () => {
  async function endReason(id: unknown): Promise<string | null> {
    const { data } = await admin
      .from("tunnel_shares")
      .select("end_reason")
      .eq("id", id as string)
      .single();
    return data?.end_reason ?? null;
  }

  async function team(owner: string, members: string[], active = true) {
    const { data, error } = await admin
      .from("teams")
      .insert({
        name: "Round two team",
        created_by: owner,
        subscription_status: active ? "active" : null,
        seats: 2,
      })
      .select("id")
      .single();
    if (error) throw error;
    createdTeamIds.push(data.id);
    await admin
      .from("team_members")
      .insert([
        { team_id: data.id, user_id: owner, role: "owner" },
        ...members.map((m) => ({ team_id: data.id, user_id: m, role: "member" })),
      ]);
    return data.id as string;
  }

  it("adds usage for a deleted account's run without failing the sync", async () => {
    const user = await createUser();
    const opened = await open(user.key);
    expect(opened.status).toBe(200);
    await admin.auth.admin.deleteUser(user.id);
    const batch = `round2-deleted-${ts}`;
    const res = await edge("sync", {
      shareIds: [opened.body.shareId],
      batches: [{ id: batch, usage: [{ id: opened.body.shareId, bytes: 2048, requests: 3 }] }],
    });
    expect(res.status).toBe(200);
    const { data: run } = await admin
      .from("tunnel_shares")
      .select("bytes, requests, end_reason")
      .eq("id", opened.body.shareId as string)
      .single();
    expect(run).toMatchObject({ bytes: 2048, requests: 3, end_reason: "account deleted" });
    const { data: applied } = await admin
      .from("tunnel_usage_batches")
      .select("id")
      .eq("id", batch)
      .maybeSingle();
    expect(applied?.id).toBe(batch);
    await admin
      .from("tunnel_shares")
      .delete()
      .eq("id", opened.body.shareId as string);
  });

  it("keeps a Free run's time limit across reconnects", async () => {
    const user = await createUser();
    const instance = `limit-run-${ts}`;
    const first = await open(user.key, { instance });
    expect(first.status).toBe(200);
    // Five minutes left on the first connection.
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    await admin
      .from("tunnel_shares")
      .update({ expires_at: soon })
      .eq("id", first.body.shareId as string);
    await edge("close", { shareId: first.body.shareId, reason: "closed" });
    const again = await open(user.key, { instance });
    expect(again.status).toBe(200);
    expect(Date.parse(again.body.expiresAt as string)).toBeLessThanOrEqual(Date.parse(soon) + 1000);
    expect(again.body.expiresIn as number).toBeLessThanOrEqual(5 * 60);
    await edge("close", { shareId: again.body.shareId, reason: "closed" });
  });

  it("hands a leaving member's team names to the owner and ends their runs under them", async () => {
    const { removeTeamMember } = await import("@/lib/supabase/teams-members");
    const owner = await createUser({ plan: "pro", request_limit: 100_000 });
    const member = await createUser({ plan: "pro", request_limit: 100_000 });
    const teamId = await team(owner.id, [member.id]);
    const name = `crew-left-${ts % 100_000}`;
    expect(
      (await api("/api/tunnel-names", "POST", member.key, { body: { name, team: teamId } })).status
    ).toBe(201);
    const run = await open(member.key, { name });
    expect(run.status).toBe(200);

    expect(await removeTeamMember(owner.id, teamId, member.id)).toBe(true);
    const { data: kept } = await admin
      .from("tunnel_names")
      .select("user_id, team_id")
      .eq("name", name)
      .single();
    expect(kept).toEqual({ user_id: owner.id, team_id: teamId });
    expect(await endReason(run.body.shareId)).toBe("access ended");

    // The former member can no longer share under it, change it or release it.
    const again = await open(member.key, { name });
    expect(again.status).toBe(409);
    expect(
      (
        await api("/api/tunnel-names/password", "PUT", member.key, {
          params: { name },
          body: { password: "correct-horse-1" },
        })
      ).status
    ).toBe(404);
    expect(
      (await api("/api/tunnel-names/name", "DELETE", member.key, { params: { name } })).status
    ).toBe(404);
  });

  it("counts team names against the team, so a handed-over name never ends the owner's own previews", async () => {
    const { removeTeamMember } = await import("@/lib/supabase/teams-members");
    const owner = await createUser({
      plan: "pro",
      request_limit: 100_000,
      paid_since: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });
    const member = await createUser({ plan: "pro", request_limit: 100_000 });
    const teamId = await team(owner.id, [member.id]);
    // The member keeps a team name first; then the owner keeps three own
    // names, all Pro covers.
    const teamName = `crew-early-${ts % 100_000}`;
    expect(
      (
        await api("/api/tunnel-names", "POST", member.key, {
          body: { name: teamName, team: teamId },
        })
      ).status
    ).toBe(201);
    const own = [1, 2, 3].map((i) => `own-${i}-${ts % 100_000}`);
    for (const name of own)
      expect((await api("/api/tunnel-names", "POST", owner.key, { body: { name } })).status).toBe(
        201
      );
    const run = await open(owner.key, { name: own[2] });
    expect(run.status).toBe(200);

    // The member leaves: the older team name goes to the owner.
    expect(await removeTeamMember(owner.id, teamId, member.id)).toBe(true);
    const synced = (await (
      await edge("sync", { shareIds: [run.body.shareId], batches: [] })
    ).json()) as { close: { shareId: string }[] };
    expect(synced.close.map((c) => c.shareId)).not.toContain(run.body.shareId);
    expect(await endReason(run.body.shareId)).toBeNull();

    // The names API counts the owner's own names against Pro, the team's
    // against the team (3 per seat, 2 seats).
    const listing = (await (await api("/api/tunnel-names", "GET", owner.key)).json()) as {
      limit: number;
      used: number;
      teams: { id: string; limit: number; used: number; active: boolean }[];
      names: { name: string; usable: boolean }[];
    };
    expect(listing.limit).toBe(3);
    expect(listing.used).toBe(3);
    expect(listing.teams).toContainEqual(
      expect.objectContaining({ id: teamId, limit: 6, used: 1, active: true })
    );
    for (const name of [...own, teamName])
      expect(listing.names).toContainEqual(expect.objectContaining({ name, usable: true }));
    await edge("close", { shareId: run.body.shareId, reason: "closed" });
  });

  it("holds a team to its names per seat", async () => {
    const owner = await createUser({ plan: "pro", request_limit: 100_000 });
    const teamId = await team(owner.id, []);
    // Teams covers 3 names a seat; the helper's team has 2 seats.
    for (let i = 1; i <= 6; i++)
      expect(
        (
          await api("/api/tunnel-names", "POST", owner.key, {
            body: { name: `seat-${i}-${ts % 100_000}`, team: teamId },
          })
        ).status
      ).toBe(201);
    const over = await api("/api/tunnel-names", "POST", owner.key, {
      body: { name: `seat-7-${ts % 100_000}`, team: teamId },
    });
    expect(over.status).toBe(403);
    expect(((await over.json()) as { error: string }).error).toMatch(/seats cover/);
    // The owner's own names are untouched by the team's.
    expect(
      (
        await api("/api/tunnel-names", "POST", owner.key, {
          body: { name: `mine-${ts % 100_000}` },
        })
      ).status
    ).toBe(201);
    // Fewer seats: the newest team names wait, the oldest stay usable.
    await admin.from("teams").update({ seats: 1 }).eq("id", teamId);
    const listing = (await (await api("/api/tunnel-names", "GET", owner.key)).json()) as {
      names: { name: string; usable: boolean }[];
    };
    expect(listing.names).toContainEqual(
      expect.objectContaining({ name: `seat-1-${ts % 100_000}`, usable: true })
    );
    expect(listing.names).toContainEqual(
      expect.objectContaining({ name: `seat-6-${ts % 100_000}`, usable: false })
    );
    const past = await open(owner.key, { name: `seat-6-${ts % 100_000}` });
    expect(past.status).toBe(403);
    expect(past.body.error).toMatch(/seats cover/);
  });

  it("ends previews under a lapsed team's names and refuses their passwords", async () => {
    const owner = await createUser({ plan: "pro", request_limit: 100_000 });
    const member = await createUser();
    const teamId = await team(owner.id, [member.id]);
    const name = `crew-lapse-${ts % 100_000}`;
    expect(
      (await api("/api/tunnel-names", "POST", owner.key, { body: { name, team: teamId } })).status
    ).toBe(201);
    const run = await open(member.key, { name });
    expect(run.status).toBe(200);

    await admin.from("teams").update({ subscription_status: null }).eq("id", teamId);
    const synced = (await (
      await edge("sync", { shareIds: [run.body.shareId], batches: [] })
    ).json()) as { close: { shareId: string }[] };
    expect(synced.close.map((c) => c.shareId)).toContain(run.body.shareId);
    expect(await endReason(run.body.shareId)).toBe("access ended");

    // The owner's own runs under it end too, and the name's password is frozen.
    expect((await open(owner.key, { name })).status).toBe(403);
    expect(
      (
        await api("/api/tunnel-names/password", "PUT", owner.key, {
          params: { name },
          body: { password: "correct-horse-1" },
        })
      ).status
    ).toBe(403);
    // Releasing still works, so a lapsed team's names are never stuck.
    expect(
      (await api("/api/tunnel-names/name", "DELETE", owner.key, { params: { name } })).status
    ).toBe(200);
  });

  it("holds open previews to the plan after a downgrade", async () => {
    const user = await createUser({
      plan: "pro",
      request_limit: 100_000,
      paid_since: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });
    const name = `downgrade-${ts % 100_000}`;
    const named = await open(user.key, { name, password: "correct-horse-1" });
    expect(named.status).toBe(200);
    const plain = await open(user.key);
    expect(plain.status).toBe(200);
    expect(plain.body.expiresAt).toBeNull();

    await admin.from("users").update({ plan: "free" }).eq("id", user.id);
    const synced = (await (
      await edge("sync", { shareIds: [named.body.shareId, plain.body.shareId], batches: [] })
    ).json()) as { close: { shareId: string; reason: string }[] };
    expect(synced.close).toContainEqual({
      shareId: named.body.shareId,
      reason: expect.stringMatching(/your plan changed/),
    });
    expect(await endReason(named.body.shareId)).toBe("plan changed");
    // The other ends too: it opened as a paid preview (no -free name, no
    // notice, no time limit), and the edge cannot tell its CLI otherwise.
    // Started again, it gets Free's name, notice and two hours.
    expect(synced.close).toContainEqual({
      shareId: plain.body.shareId,
      reason: expect.stringMatching(/your plan changed/),
    });
    expect(await endReason(plain.body.shareId)).toBe("plan changed");
    const again = await open(user.key);
    expect(again.status).toBe(200);
    expect(again.body.name).toMatch(/-free$/);
    expect(again.body.notice).toBe(true);
    expect(again.body.expiresIn).toBe(120 * 60);

    // The kept name is past Free's count: listed, not usable.
    const names = (await (await api("/api/tunnel-names", "GET", user.key)).json()) as {
      names: { name: string; usable: boolean }[];
    };
    expect(names.names).toContainEqual(expect.objectContaining({ name, usable: false }));
    await edge("close", { shareId: again.body.shareId, reason: "closed" });
  });

  it("covers only the oldest reserved names after a downgrade to fewer", async () => {
    const user = await createUser({ plan: "business", request_limit: 250_000 });
    const names = [1, 2, 3, 4].map((i) => `count-${i}-${ts % 100_000}`);
    for (const name of names)
      expect((await api("/api/tunnel-names", "POST", user.key, { body: { name } })).status).toBe(
        201
      );
    await admin.from("users").update({ plan: "pro" }).eq("id", user.id);
    // Pro covers three: the fourth kept is refused, the first three open.
    expect((await open(user.key, { name: names[0] })).status).toBe(200);
    const past = await open(user.key, { name: names[3] });
    expect(past.status).toBe(403);
    expect(past.body.error).toMatch(/past that/);
  });

  it("lets an endpoint's owner see and stop a teammate's live tunnel on it", async () => {
    const owner = await createUser({ plan: "pro", request_limit: 100_000 });
    const member = await createUser();
    const teamId = await team(owner.id, [member.id]);
    const slug = `own${ts % 1_000_000}`;
    const { data: endpoint, error } = await admin
      .from("endpoints")
      .insert({ user_id: owner.id, slug, name: "owned" })
      .select("id")
      .single();
    if (error) throw error;
    await admin
      .from("team_endpoints")
      .insert({ team_id: teamId, endpoint_id: endpoint.id, shared_by: owner.id });
    const live = await open(member.key, { kind: "live", endpoint: slug });
    expect(live.status).toBe(200);

    const view = (await (
      await api("/api/shares", "GET", owner.key, { url: "http://localhost/api/shares?state=live" })
    ).json()) as { shares: { id: string; mine: boolean; kind: string }[] };
    expect(view.shares).toContainEqual(
      expect.objectContaining({ id: live.body.shareId, mine: false, kind: "live" })
    );
    const stop = await api("/api/shares/stop", "POST", owner.key, {
      params: { id: live.body.shareId as string },
    });
    expect(stop.status).toBe(200);
    expect(await endReason(live.body.shareId)).toBe("stopped by the endpoint owner");
  });

  it("ends runs of suspended accounts, deleted keys and deleted endpoints with their reason", async () => {
    const { deleteEndpointBySlugForUser } = await import("@/lib/supabase/endpoints");
    const suspended = await createUser();
    const a = await open(suspended.key);
    await admin.from("users").update({ tunnels_suspended: true }).eq("id", suspended.id);

    const keyed = await createUser();
    const b = await open(keyed.key);
    await admin.from("api_keys").delete().eq("user_id", keyed.id);

    await edge("sync", { shareIds: [a.body.shareId, b.body.shareId], batches: [] });
    expect(await endReason(a.body.shareId)).toBe("sharing suspended");
    expect(await endReason(b.body.shareId)).toBe("key revoked");

    const owner = await createUser();
    const slug = `gone${ts % 1_000_000}`;
    await admin.from("endpoints").insert({ user_id: owner.id, slug, name: "doomed" });
    const live = await open(owner.key, { kind: "live", endpoint: slug });
    expect(live.status).toBe(200);
    expect(await deleteEndpointBySlugForUser(owner.id, slug)).toBe(true);
    const { data: run } = await admin
      .from("tunnel_shares")
      .select("endpoint_id, end_reason")
      .eq("id", live.body.shareId as string)
      .single();
    expect(run).toEqual({ endpoint_id: null, end_reason: "endpoint deleted" });
  });

  it("stops a preview when its reserved name is released", async () => {
    const user = await createUser({ plan: "pro", request_limit: 100_000 });
    const name = `let-go-${ts % 100_000}`;
    expect((await api("/api/tunnel-names", "POST", user.key, { body: { name } })).status).toBe(201);
    const run = await open(user.key, { name });
    expect(run.status).toBe(200);
    expect(
      (await api("/api/tunnel-names/name", "DELETE", user.key, { params: { name } })).status
    ).toBe(200);
    expect(await endReason(run.body.shareId)).toBe("name released");
  });

  it("keeps an endpoint live for two minutes after its session drops, not after a stop", async () => {
    const user = await createUser();
    const slug = `grace${ts % 1_000_000}`;
    const { data: endpoint, error } = await admin
      .from("endpoints")
      .insert({ user_id: user.id, slug, name: "grace" })
      .select("id")
      .single();
    if (error) throw error;
    const capture = async () => {
      const { data, error: captureError } = await admin.rpc("capture_webhook", {
        p_slug: slug,
        p_method: "POST",
        p_path: `/w/${slug}`,
        p_headers: {},
        p_body: "{}",
        p_query_params: {},
        p_content_type: "application/json",
        p_ip: "192.0.2.10",
        p_received_at: new Date().toISOString(),
      });
      if (captureError) throw captureError;
      return (data as { live?: boolean }).live;
    };
    const graceOf = async () =>
      (await admin.from("endpoints").select("live_grace_until").eq("id", endpoint.id).single()).data
        ?.live_grace_until ?? null;

    const first = await open(user.key, { kind: "live", endpoint: slug });
    expect(await capture()).toBe(true);
    // The tunnel fell: still live, so senders get the edge's 502.
    await edge("close", { shareId: first.body.shareId, reason: "closed" });
    expect(await graceOf()).not.toBeNull();
    expect(await capture()).toBe(true);
    // A new session clears the grace; a stop ends it at once.
    const second = await open(user.key, { kind: "live", endpoint: slug });
    expect(await graceOf()).toBeNull();
    await api("/api/shares/stop", "POST", user.key, {
      params: { id: second.body.shareId as string },
    });
    expect(await graceOf()).toBeNull();
    expect(await capture()).toBe(false);
  });
});

describe("round four: lost closes, team names on deletion, errors and races", () => {
  async function row(id: unknown) {
    const { data } = await admin
      .from("tunnel_shares")
      .select("ended_at, end_reason")
      .eq("id", id as string)
      .single();
    return data;
  }

  async function team(owner: string, members: string[]) {
    const { data, error } = await admin
      .from("teams")
      .insert({
        name: "Round four team",
        created_by: owner,
        subscription_status: "active",
        seats: 2,
      })
      .select("id")
      .single();
    if (error) throw error;
    createdTeamIds.push(data.id);
    await admin
      .from("team_members")
      .insert([
        { team_id: data.id, user_id: owner, role: "owner" },
        ...members.map((m) => ({ team_id: data.id, user_id: m, role: "member" })),
      ]);
    return data.id as string;
  }

  const age = (id: unknown, seconds: number) =>
    admin
      .from("tunnel_shares")
      .update({ started_at: new Date(Date.now() - seconds * 1000).toISOString() })
      .eq("id", id as string);

  it("ends runs the edge no longer holds, so a lost close frees the slot and the endpoint", async () => {
    const free = await createUser();
    const lost = await open(free.key);
    expect(lost.status).toBe(200);
    // Its close never arrived: the edge lists nothing.
    expect((await open(free.key)).status).toBe(429);
    await age(lost.body.shareId, 120);

    const pro = await createUser({ plan: "pro" });
    const slug = `unheld${ts % 1_000_000}`;
    const { data: endpoint, error } = await admin
      .from("endpoints")
      .insert({ user_id: pro.id, slug, name: "unheld" })
      .select("id")
      .single();
    if (error) throw error;
    const live = await open(pro.key, { kind: "live", endpoint: slug });
    expect(live.status).toBe(200);
    await age(live.body.shareId, 120);
    // A run the edge has not listed yet is left alone.
    const young = await open(pro.key);
    expect(young.status).toBe(200);

    const synced = await edge("sync", { shareIds: [], batches: [] });
    expect(synced.status).toBe(200);
    expect((await row(lost.body.shareId))?.end_reason).toBe("closed");
    expect((await row(live.body.shareId))?.end_reason).toBe("closed");
    expect((await row(young.body.shareId))?.ended_at).toBeNull();
    const { data: ep } = await admin
      .from("endpoints")
      .select("live_session_id, live_grace_until")
      .eq("id", endpoint.id)
      .single();
    expect(ep?.live_session_id).toBeNull();
    expect(ep?.live_grace_until).not.toBeNull();
    // The Free slot is free again.
    expect((await open(free.key)).status).toBe(200);
  });

  it("hands a deleted member's team names to the owner, and a deleted team's names go with it", async () => {
    const owner = await createUser({ plan: "pro" });
    const member = await createUser();
    const teamId = await team(owner.id, [member.id]);
    const name = `tn4-${ts % 1_000_000}`;
    const kept = await api("/api/tunnel-names", "POST", member.key, {
      body: { name, team: teamId },
    });
    expect(kept.status).toBe(201);

    await admin.auth.admin.deleteUser(member.id);
    const { data: after } = await admin
      .from("tunnel_names")
      .select("user_id, team_id")
      .eq("name", name)
      .single();
    expect(after).toEqual({ user_id: owner.id, team_id: teamId });

    // A preview under the team's name stops before the team goes; the name goes too.
    const run = await open(owner.key, { name });
    expect(run.status).toBe(200);
    const { stopSharesUnderTeamNames } = await import("@/lib/tunnels/names");
    await stopSharesUnderTeamNames([teamId]);
    expect((await row(run.body.shareId))?.end_reason).toBe("access ended");
    await admin.from("teams").delete().eq("id", teamId);
    const { data: gone } = await admin.from("tunnel_names").select("name").eq("name", name);
    expect(gone).toEqual([]);
  });

  it("answers name changes an agent can act on", async () => {
    const owner = await createUser({ plan: "pro" });
    const tooLong = await api("/api/tunnel-names", "POST", owner.key, {
      body: { name: "a".repeat(101) },
    });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { error: string }).error).toMatch(/3 to 40 characters/);

    const unknown = await api("/api/tunnel-names/name", "DELETE", owner.key, {
      params: { name: `nobody-${ts % 1_000_000}` },
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toMatch(/whk names ls/);

    // Reserving one's own name with a team moves it into the team.
    const teamId = await team(owner.id, []);
    const name = `move-${ts % 1_000_000}`;
    expect((await api("/api/tunnel-names", "POST", owner.key, { body: { name } })).status).toBe(
      201
    );
    const moved = await api("/api/tunnel-names", "POST", owner.key, {
      body: { name, team: teamId },
    });
    expect(moved.status).toBe(201);
    const { data: nameRow } = await admin
      .from("tunnel_names")
      .select("team_id")
      .eq("name", name)
      .single();
    expect(nameRow?.team_id).toBe(teamId);
    // Asking again is a no-op.
    expect(
      (await api("/api/tunnel-names", "POST", owner.key, { body: { name, team: teamId } })).status
    ).toBe(200);

    // One's own runs carry no startedBy.
    const run = await open(owner.key);
    expect(run.status).toBe(200);
    const listed = (await (
      await api("/api/shares", "GET", owner.key, { url: "http://localhost/api/shares?state=live" })
    ).json()) as { shares: { id: string; startedBy: unknown }[] };
    expect(listed.shares.find((s) => s.id === run.body.shareId)?.startedBy).toBeNull();
  });

  it("ends previews under a blocked name, and refuses a reconnect of a stopped run under the lock", async () => {
    const user = await createUser({ plan: "pro" });
    const name = `blk-${ts % 1_000_000}`;
    const run = await open(user.key, { name });
    expect(run.status).toBe(200);
    // Blocked while the run was opening: the access check catches it.
    await admin.from("tunnel_blocked_names").insert({ name, reason: "test" });
    await edge("sync", { shareIds: [run.body.shareId], batches: [] });
    expect((await row(run.body.shareId))?.end_reason).toBe("name blocked");
    await admin.from("tunnel_blocked_names").delete().eq("name", name);

    const { FINAL_ENDINGS } = await import("@/lib/tunnels/stops");
    const { data, error } = await admin.rpc("tunnel_open_share", {
      p_user_id: user.id,
      p_kind: "share",
      p_name: `other-${ts % 1_000_000}`,
      p_endpoint_id: null,
      p_slots: 3,
      p_session_minutes: null,
      p_free: false,
      p_client: "",
      p_key_id: null,
      p_instance: "stopped-run",
      p_client_address: null,
      p_password_hash: null,
      p_password_version: null,
      p_final_endings: FINAL_ENDINGS,
    });
    if (error) throw error;
    expect((data as { shareId?: string }).shareId).toBeTruthy();
    await admin
      .from("tunnel_shares")
      .update({ ended_at: new Date().toISOString(), end_reason: "stopped" })
      .eq("id", (data as { shareId: string }).shareId);
    const { data: again } = await admin.rpc("tunnel_open_share", {
      p_user_id: user.id,
      p_kind: "share",
      p_name: `other-${ts % 1_000_000}`,
      p_endpoint_id: null,
      p_slots: 3,
      p_session_minutes: null,
      p_free: false,
      p_client: "",
      p_key_id: null,
      p_instance: "stopped-run",
      p_client_address: null,
      p_password_hash: null,
      p_password_version: null,
      p_final_endings: FINAL_ENDINGS,
    });
    expect(again).toEqual({ error: "stopped", reason: "stopped" });
  });

  it("makes a stop stick while the CLI is between reconnects", async () => {
    const user = await createUser();
    const instance = `gap-${Math.random().toString(36).slice(2)}`;
    const first = await open(user.key, { instance });
    expect(first.status).toBe(200);
    // The tunnel dropped; the CLI has not reconnected yet.
    await edge("close", { shareId: first.body.shareId, reason: "closed" });
    const stop = await api("/api/shares/stop", "POST", user.key, {
      params: { id: first.body.shareId as string },
    });
    expect(stop.status).toBe(200);
    expect(((await stop.json()) as { stopped: boolean }).stopped).toBe(true);
    expect((await row(first.body.shareId))?.end_reason).toBe("stopped through the API");
    // The reconnect is refused.
    expect((await open(user.key, { instance })).status).toBe(410);
  });

  it("stops a run that already reconnected when the stop names its earlier row", async () => {
    const user = await createUser();
    const instance = `gap2-${Math.random().toString(36).slice(2)}`;
    const first = await open(user.key, { instance });
    await edge("close", { shareId: first.body.shareId, reason: "closed" });
    const second = await open(user.key, { instance });
    expect(second.status).toBe(200);
    await api("/api/shares/stop", "POST", user.key, {
      params: { id: first.body.shareId as string },
    });
    expect((await row(second.body.shareId))?.ended_at).not.toBeNull();
    expect((await open(user.key, { instance })).status).toBe(410);
  });
});
