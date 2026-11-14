/**
 * @fileoverview Organisation ID-JAG issuers a team trusts (migration 00105):
 * the owner adds an issuer with a session, a member's agent presents the
 * member's ID-JAG at the token endpoint, the first use needs the member's
 * claim, later ones connect directly, and removing the issuer or leaving the
 * team revokes the connection and its tokens. A member's window ("Connect"
 * on the team page) binds the first matching assertion at once; outside
 * it, wrong email, after expiry and after Disconnect, nothing binds. The
 * relaxed claims (no auth_time on a short-lived assertion, email_verified
 * absent) and the list read with an API key or agent token are covered too.
 *
 * Needs the local Supabase stack with migration 00105 applied, and
 * AGENT_ASSERTION_SIGNING_KEY plus AGENT_POW_SECRET in .env.local. Run with:
 *   cd apps/web && npx vitest run --config vitest.config.ts tests/integration/team-idjag-issuers.test.ts
 *
 * The fake issuer is a local ES256 key whose discovery document and JWKS
 * this suite serves: the outbound fetch (lib/forwarding/send.ts, which goes
 * through the notify proxy in production) is replaced by one that answers
 * from the suite's documents, since the issuer's https host does not exist.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import * as jose from "jose";
import { randomBytes, randomUUID } from "node:crypto";
import { hashApiKey } from "@/lib/supabase/api-keys";
import {
  adminClient,
  APP,
  bearer,
  cleanupRegistrations,
  configureAgentEnv,
  formPost,
  loadAgentRoutes,
  type AgentRoutes,
} from "./agent-helpers";

const PREFIX = "https://identity.idjag-test.local/issuers/";
configureAgentEnv({ AGENT_IDJAG_ORG_ISSUER_PREFIXES: PREFIX });

const documents = new Map<string, string>();
const fetched: string[] = [];
vi.mock("@/lib/forwarding/send", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/forwarding/send")>();
  return {
    ...original,
    sendForward: async (outgoing: { url: string }) => {
      fetched.push(outgoing.url);
      const text = documents.get(outgoing.url);
      return text === undefined
        ? { status: 404, excerpt: null, error: null, durationMs: 1 }
        : { status: 200, excerpt: text.slice(0, 1024), error: null, durationMs: 1 };
    },
  };
});

const admin = adminClient();
const RUN = Date.now();
const ISS = `${PREFIX}org-${RUN}`;
const CLIENT = "https://client.idjag-test.local/oauth/client.json";
const PASSWORD = "TestPassword123!";
const OWNER_EMAIL = `idjag-owner-${RUN}@webhooks-test.local`;
const MEMBER_EMAIL = `idjag-member-${RUN}@webhooks-test.local`;
const OUTSIDER_EMAIL = `idjag-outsider-${RUN}@webhooks-test.local`;
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";

type Handler = (request: Request) => Promise<Response>;
type TeamHandler = (
  request: Request,
  ctx: { params: Promise<{ teamId: string }> }
) => Promise<Response>;
type IssuerHandler = (
  request: Request,
  ctx: { params: Promise<{ teamId: string; issuerId: string }> }
) => Promise<Response>;

let routes: AgentRoutes;
let issuersGet: TeamHandler;
let issuersPost: TeamHandler;
let issuerDelete: IssuerHandler;
let connectPost: IssuerHandler;
let connectDelete: IssuerHandler;
let attemptGet: Handler;
let leavePost: TeamHandler;
let completePost: Handler;
let registrationsGet: Handler;
let key: CryptoKey;
let teamId: string;
let ownerId: string;
let memberId: string;
let ownerSession: string;
let memberSession: string;
const userIds: string[] = [];
const registrations = new Set<string>();
const jtis = new Set<string>();

async function makeUser(email: string): Promise<{ id: string; session: string }> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  userIds.push(data.user!.id);
  const anon = createClient(process.env.SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (signInError) throw signInError;
  return { id: data.user!.id, session: signIn.session!.access_token };
}

async function mint(
  sub: string,
  email: string,
  overrides: {
    clientId?: string;
    authTime?: boolean;
    emailVerified?: boolean | null;
    ttl?: number;
  } = {}
) {
  const jti = randomUUID();
  jtis.add(jti);
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { client_id: overrides.clientId ?? CLIENT, email };
  if (overrides.emailVerified !== null) claims.email_verified = overrides.emailVerified ?? true;
  if (overrides.authTime !== false) claims.auth_time = now - 30;
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", typ: "oauth-id-jag+jwt", kid: "org-key-1" })
    .setIssuer(ISS)
    .setSubject(sub)
    .setAudience(APP)
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides.ttl ?? 60))
    .setJti(jti)
    .sign(key);
}

function present(assertion: string, clientId = CLIENT): Promise<Response> {
  return routes.token(
    formPost("/api/oauth2/token", {
      grant_type: JWT_BEARER,
      assertion,
      client_id: clientId,
      resource: `${APP}/mcp`,
    })
  );
}

function teamCtx() {
  return { params: Promise.resolve({ teamId }) };
}

async function addIssuer(session: string, body: unknown): Promise<Response> {
  return issuersPost(
    bearer("POST", `/api/teams/${teamId}/idjag-issuers`, session, body),
    teamCtx()
  );
}

/** First use: interaction_required, the member confirms, the claim grant pays out. */
async function connectThroughClaim(
  sub: string
): Promise<{ registrationId: string; token: string }> {
  const first = await present(await mint(sub, MEMBER_EMAIL));
  expect(first.status).toBe(400);
  const body = await first.json();
  registrations.add(body.registration_id);
  expect(body).toMatchObject({
    error: "interaction_required",
    registration_type: "identity_assertion",
    claim: { interval: 5 },
  });
  expect(body.claim_token).toMatch(/^clm_/);
  // The member is pointed at the team page to connect.
  expect(body.error_description).toContain(`${APP}/teams/${teamId}#agent-sign-in`);

  // Nothing is bound before the member confirms.
  const { data: pending } = await admin
    .from("agent_registrations")
    .select("user_id, claimed_at, attempt_login_hint, idjag_team_issuer_id")
    .eq("id", body.registration_id)
    .single();
  expect(pending).toMatchObject({
    user_id: null,
    claimed_at: null,
    attempt_login_hint: MEMBER_EMAIL,
  });
  expect(pending!.idjag_team_issuer_id).not.toBeNull();

  const attempt = new URL(body.claim.verification_uri).searchParams.get("attempt")!;
  const done = await completePost(
    bearer("POST", "/api/agent/identity/claim/complete", memberSession, {
      claim_attempt_token: attempt,
      user_code: body.claim.user_code,
    })
  );
  expect(done.status).toBe(200);
  const collected = await routes.token(
    formPost("/api/oauth2/token", { grant_type: CLAIM_GRANT, claim_token: body.claim_token })
  );
  expect(collected.status).toBe(200);
  const tokens = await collected.json();
  return { registrationId: body.registration_id, token: tokens.access_token };
}

async function tokenWorks(token: string): Promise<boolean> {
  const res = await registrationsGet(bearer("GET", "/api/agent/registrations", token));
  return res.status === 200;
}

async function revokedAudit(registrationId: string) {
  const { data } = await admin
    .from("audit_events")
    .select("actor_type, team_id, metadata")
    .eq("action", "agent.registration.revoked")
    .eq("target_id", registrationId);
  return data ?? [];
}

describe("team ID-JAG issuers", () => {
  beforeAll(async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("ES256");
    key = privateKey;
    const jwk = {
      ...(await jose.exportJWK(publicKey)),
      kid: "org-key-1",
      alg: "ES256",
      use: "sig",
    };
    const jwksUri = `https://identity.idjag-test.local/jwks/org-${RUN}`;
    documents.set(
      `${ISS}/.well-known/openid-configuration`,
      JSON.stringify({ issuer: ISS, jwks_uri: jwksUri })
    );
    documents.set(jwksUri, JSON.stringify({ keys: [jwk] }));

    routes = await loadAgentRoutes();
    const [issuers, issuer, connectRoute, attempt, leave, complete, regs] = await Promise.all([
      import("@/app/api/teams/[teamId]/idjag-issuers/route"),
      import("@/app/api/teams/[teamId]/idjag-issuers/[issuerId]/route"),
      import("@/app/api/teams/[teamId]/idjag-issuers/[issuerId]/connect/route"),
      import("@/app/api/agent/identity/claim/attempt/route"),
      import("@/app/api/teams/[teamId]/leave/route"),
      import("@/app/api/agent/identity/claim/complete/route"),
      import("@/app/api/agent/registrations/route"),
    ]);
    issuersGet = issuers.GET;
    issuersPost = issuers.POST;
    issuerDelete = issuer.DELETE;
    connectPost = connectRoute.POST;
    connectDelete = connectRoute.DELETE;
    attemptGet = attempt.GET;
    leavePost = leave.POST;
    completePost = complete.POST;
    registrationsGet = regs.GET;

    const owner = await makeUser(OWNER_EMAIL);
    const member = await makeUser(MEMBER_EMAIL);
    await makeUser(OUTSIDER_EMAIL);
    ownerId = owner.id;
    memberId = member.id;
    ownerSession = owner.session;
    memberSession = member.session;

    const { data: team, error } = await admin.rpc("create_team_with_owner", {
      p_user_id: ownerId,
      p_name: `ID-JAG team ${RUN}`,
    });
    if (error) throw error;
    teamId = (team as { id: string }).id;
    const { error: memberError } = await admin
      .from("team_members")
      .insert({ team_id: teamId, user_id: memberId, role: "member" });
    if (memberError) throw memberError;
  });

  afterAll(async () => {
    await cleanupRegistrations(admin, registrations);
    if (jtis.size > 0)
      await admin
        .from("agent_idjag_jti")
        .delete()
        .in("jti", [...jtis]);
    if (teamId) await admin.from("teams").delete().eq("id", teamId);
    for (const id of userIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  it("lets only the owner add an issuer, with a session, under a configured prefix", async () => {
    // An API key is refused before anything else.
    const withKey = await addIssuer("whcc_not_a_session_token", { issuer: ISS });
    expect(withKey.status).toBe(403);
    // A member is not the owner.
    expect((await addIssuer(memberSession, { issuer: ISS })).status).toBe(404);
    // Outside the prefix.
    const outside = await addIssuer(ownerSession, { issuer: "https://elsewhere.test/issuers/x" });
    expect(outside.status).toBe(400);

    const added = await addIssuer(ownerSession, { issuer: ISS });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ issuer: ISS, allowed_client_ids: [] });
    expect((await addIssuer(ownerSession, { issuer: ISS })).status).toBe(409);

    // Members see the list but cannot manage it.
    const listed = await issuersGet(
      bearer("GET", `/api/teams/${teamId}/idjag-issuers`, memberSession),
      teamCtx()
    );
    expect(await listed.json()).toMatchObject({
      issuers: [{ issuer: ISS }],
      prefixes: [PREFIX],
      can_manage: false,
    });

    const { data: audit } = await admin
      .from("audit_events")
      .select("outcome")
      .eq("action", "team.idjag_issuer_added")
      .eq("team_id", teamId);
    expect(audit?.map((row) => row.outcome).sort()).toEqual([
      "ok",
      "refused",
      "refused",
      "refused",
    ]);
  });

  it("refuses someone who is not a member, and never creates an account", async () => {
    const res = await present(await mint(`outsider-${RUN}`, OUTSIDER_EMAIL));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("access_denied");

    const nobody = `idjag-nobody-${RUN}@webhooks-test.local`;
    const none = await present(await mint(`nobody-${RUN}`, nobody));
    expect((await none.json()).error).toBe("access_denied");
    const { data: user } = await admin.from("users").select("id").eq("email", nobody).maybeSingle();
    expect(user).toBeNull();
  });

  it("names the team and the issuer's host on the claim page", async () => {
    const sub = `claim-page-${RUN}`;
    const first = await (await present(await mint(sub, MEMBER_EMAIL))).json();
    registrations.add(first.registration_id);
    const attempt = new URL(first.claim.verification_uri).searchParams.get("attempt")!;
    const view = await attemptGet(
      bearer("GET", `/api/agent/identity/claim/attempt?attempt=${attempt}`, memberSession)
    );
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({
      trustedBy: { team: `ID-JAG team ${RUN}`, host: "identity.idjag-test.local" },
      clientName: "client.idjag-test.local",
    });
    await admin.from("agent_registrations").delete().eq("id", first.registration_id);
  });

  it("needs the member's claim on first use, then connects directly", async () => {
    const sub = `member-${RUN}`;
    const { registrationId, token } = await connectThroughClaim(sub);
    expect(await tokenWorks(token)).toBe(true);

    const again = await present(await mint(sub, MEMBER_EMAIL));
    expect(again.status).toBe(200);
    const body = await again.json();
    expect(body).toMatchObject({ token_type: "Bearer", scope: "webhooks:read webhooks:write" });
    expect(body.refresh_token).toBeUndefined();
    expect(await tokenWorks(body.access_token)).toBe(true);

    // The token belongs to the member, through the same registration.
    const { data: apiKeyRow } = await admin
      .from("api_keys")
      .select("user_id, agent_registration_id")
      .eq("agent_registration_id", registrationId)
      .limit(1)
      .single();
    expect(apiKeyRow).toMatchObject({ user_id: memberId, agent_registration_id: registrationId });

    // The same assertion twice is a replay; another client is refused.
    const assertion = await mint(sub, MEMBER_EMAIL);
    expect((await present(assertion)).status).toBe(200);
    expect((await (await present(assertion)).json()).error).toBe("invalid_grant");
    const wrongClient = await present(await mint(sub, MEMBER_EMAIL), "https://other.test/c.json");
    expect((await wrongClient.json()).error).toBe("invalid_grant");

    const { data: issued } = await admin
      .from("audit_events")
      .select("team_id, metadata")
      .eq("action", "agent.token.issued")
      .eq("target_id", registrationId);
    expect(issued?.some((row) => row.team_id === teamId)).toBe(true);
  });

  it("revokes the connection and its tokens when the issuer is removed", async () => {
    const sub = `member-${RUN}`;
    const direct = await (await present(await mint(sub, MEMBER_EMAIL))).json();
    expect(await tokenWorks(direct.access_token)).toBe(true);
    const { data: row } = await admin
      .from("agent_registrations")
      .select("id")
      .eq("idjag_iss", ISS)
      .eq("idjag_sub", sub)
      .is("revoked_at", null)
      .single();

    const listed = await (
      await issuersGet(bearer("GET", `/api/teams/${teamId}/idjag-issuers`, ownerSession), teamCtx())
    ).json();
    const issuerId = listed.issuers[0].id;
    // A member cannot remove it.
    const byMember = await issuerDelete(
      bearer("DELETE", `/api/teams/${teamId}/idjag-issuers/${issuerId}`, memberSession),
      { params: Promise.resolve({ teamId, issuerId }) }
    );
    expect(byMember.status).toBe(404);

    const removed = await issuerDelete(
      bearer("DELETE", `/api/teams/${teamId}/idjag-issuers/${issuerId}`, ownerSession),
      { params: Promise.resolve({ teamId, issuerId }) }
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ success: true, revoked_connections: 1 });

    expect(await tokenWorks(direct.access_token)).toBe(false);
    const { data: after } = await admin
      .from("agent_registrations")
      .select("revoked_at")
      .eq("id", row!.id)
      .single();
    expect(after?.revoked_at).not.toBeNull();
    expect(await revokedAudit(row!.id)).toEqual([
      {
        actor_type: "system",
        team_id: teamId,
        metadata: { kind: "identity_assertion", source: "team_issuer_removed", issuer: ISS },
      },
    ]);

    // No team trusts the issuer now.
    const refused = await present(await mint(sub, MEMBER_EMAIL));
    expect((await refused.json()).error).toBe("invalid_grant");
  });

  it("revokes the connection and its tokens when the member leaves the team", async () => {
    expect(
      (await addIssuer(ownerSession, { issuer: ISS, allowed_client_ids: [CLIENT] })).status
    ).toBe(201);
    // The earlier delegation was revoked, so the identity needs its claim again.
    const sub = `member-${RUN}`;
    const { registrationId, token } = await connectThroughClaim(sub);
    expect(await tokenWorks(token)).toBe(true);

    // The row lists one client: another is refused as not allowed.
    const other = await present(
      await mint(sub, MEMBER_EMAIL, { clientId: "https://other.test/c.json" }),
      "https://other.test/c.json"
    );
    expect((await other.json()).error).toBe("access_denied");

    const left = await leavePost(
      bearer("POST", `/api/teams/${teamId}/leave`, memberSession),
      teamCtx()
    );
    expect(left.status).toBe(200);

    expect(await tokenWorks(token)).toBe(false);
    expect(await revokedAudit(registrationId)).toEqual([
      {
        actor_type: "system",
        team_id: teamId,
        metadata: { kind: "identity_assertion", source: "team_member_left", issuer: ISS },
      },
    ]);
    const refused = await present(await mint(sub, MEMBER_EMAIL));
    expect((await refused.json()).error).toBe("access_denied");
  });

  describe("a member's connect window", () => {
    let issuerId: string;
    const issuerCtx = () => ({ params: Promise.resolve({ teamId, issuerId }) });
    const openWindow = (session: string) =>
      connectPost(
        bearer("POST", `/api/teams/${teamId}/idjag-issuers/${issuerId}/connect`, session),
        issuerCtx()
      );
    const disconnect = (session: string) =>
      connectDelete(
        bearer("DELETE", `/api/teams/${teamId}/idjag-issuers/${issuerId}/connect`, session),
        issuerCtx()
      );
    const listAs = async (token: string) =>
      issuersGet(bearer("GET", `/api/teams/${teamId}/idjag-issuers`, token), teamCtx());
    const auditFor = async (action: string) => {
      const { data } = await admin
        .from("audit_events")
        .select("actor_type, outcome, team_id, target_id, target_user_id, metadata")
        .eq("action", action)
        .eq("team_id", teamId)
        .order("occurred_at", { ascending: true });
      return data ?? [];
    };

    beforeAll(async () => {
      // The member left in the test before; back in.
      const { error } = await admin
        .from("team_members")
        .insert({ team_id: teamId, user_id: memberId, role: "member" });
      if (error) throw error;
      const listed = await (await listAs(ownerSession)).json();
      issuerId = listed.issuers[0].id;
    });

    it("opens only with the member's own session", async () => {
      expect((await openWindow("whcc_not_a_session_token")).status).toBe(403);
      const outsider = await makeUser(`idjag-outsider2-${RUN}@webhooks-test.local`);
      expect((await openWindow(outsider.session)).status).toBe(404);
      expect((await disconnect(outsider.session)).status).toBe(404);
    });

    it("refuses outside a window, and binds the first matching assertion inside it", async () => {
      const sub = `window-${RUN}`;
      // No window: the claim ceremony, nothing bound.
      const outside = await present(await mint(sub, MEMBER_EMAIL));
      const outsideBody = await outside.json();
      registrations.add(outsideBody.registration_id);
      expect(outsideBody.error).toBe("interaction_required");

      const opened = await openWindow(memberSession);
      expect(opened.status).toBe(200);
      const { window_expires_at } = await opened.json();
      const left = Date.parse(window_expires_at) - Date.now();
      expect(left).toBeGreaterThan(590_000);
      expect(left).toBeLessThanOrEqual(600_000);

      // Inside it: a token at once, and the pending ceremony is replaced.
      const inside = await present(await mint(sub, MEMBER_EMAIL));
      expect(inside.status).toBe(200);
      const token = (await inside.json()).access_token;
      expect(await tokenWorks(token)).toBe(true);
      const { data: row } = await admin
        .from("agent_registrations")
        .select("id, user_id, client_name, idjag_team_issuer_id")
        .eq("idjag_iss", ISS)
        .eq("idjag_sub", sub)
        .is("revoked_at", null)
        .single();
      registrations.add(row!.id);
      expect(row).toMatchObject({
        user_id: memberId,
        client_name: "client.idjag-test.local",
        idjag_team_issuer_id: issuerId,
      });
      const { data: pending } = await admin
        .from("agent_registrations")
        .select("id")
        .eq("id", outsideBody.registration_id)
        .maybeSingle();
      expect(pending).toBeNull();

      // The window closed: another identity of the same person needs a claim.
      const second = await (await present(await mint(`window-b-${RUN}`, MEMBER_EMAIL))).json();
      registrations.add(second.registration_id);
      expect(second.error).toBe("interaction_required");
      // Pending ceremonies count against the member's cap; drop this one.
      await admin.from("agent_registrations").delete().eq("id", second.registration_id);

      // The list shows the connection, read with the member's agent token.
      const listed = await listAs(token);
      expect(listed.status).toBe(200);
      expect((await listed.json()).issuers[0].connect).toMatchObject({
        window_expires_at: null,
        connections: [{ id: row!.id, client_name: "client.idjag-test.local" }],
      });

      expect(await auditFor("team.idjag_connect_opened")).toContainEqual(
        expect.objectContaining({ outcome: "ok", target_id: issuerId, target_user_id: null })
      );
      expect(await auditFor("team.idjag_connect_bound")).toContainEqual(
        expect.objectContaining({
          actor_type: "agent",
          outcome: "ok",
          target_id: row!.id,
          target_user_id: memberId,
        })
      );
    });

    it("never binds another person's email inside the member's window", async () => {
      // The owner is a member too, but the window is the member's.
      expect((await openWindow(memberSession)).status).toBe(200);
      const owners = await present(await mint(`window-owner-${RUN}`, OWNER_EMAIL));
      const body = await owners.json();
      registrations.add(body.registration_id);
      expect(body.error).toBe("interaction_required");
      // Someone outside the team: refused, and the window stays open.
      const outsider = await present(await mint(`window-out-${RUN}`, OUTSIDER_EMAIL));
      expect((await outsider.json()).error).toBe("access_denied");
      const listed = await (await listAs(memberSession)).json();
      expect(listed.issuers[0].connect.window_expires_at).not.toBeNull();
    });

    it("binds nothing after the window expired, and records the unused expiry", async () => {
      // The window from the test before, moved into the past.
      const { error } = await admin
        .from("team_idjag_connect_windows")
        .update({
          opened_at: new Date(Date.now() - 700_000).toISOString(),
          expires_at: new Date(Date.now() - 1000).toISOString(),
        })
        .eq("trust_id", issuerId)
        .eq("user_id", memberId);
      if (error) throw error;
      const late = await (await present(await mint(`window-late-${RUN}`, MEMBER_EMAIL))).json();
      registrations.add(late.registration_id);
      expect(late.error).toBe("interaction_required");
      await admin.from("agent_registrations").delete().eq("id", late.registration_id);

      // pg_cron runs this every minute; run it now (it may have already).
      const { error: expireError } = await admin.rpc("expire_team_idjag_connect_windows");
      if (expireError) throw expireError;
      const { data: windows } = await admin
        .from("team_idjag_connect_windows")
        .select("trust_id")
        .eq("trust_id", issuerId)
        .eq("user_id", memberId);
      expect(windows).toEqual([]);
      expect(await auditFor("team.idjag_connect_expired")).toContainEqual(
        expect.objectContaining({
          actor_type: "system",
          target_id: issuerId,
          target_user_id: memberId,
          metadata: expect.objectContaining({ issuer: ISS }),
        })
      );
    });

    it("disconnects the member's connections and their tokens", async () => {
      expect((await openWindow(memberSession)).status).toBe(200);
      const sub = `window-${RUN}`;
      // Already bound in the earlier test: a direct token.
      const direct = await (await present(await mint(sub, MEMBER_EMAIL))).json();
      expect(await tokenWorks(direct.access_token)).toBe(true);

      const res = await disconnect(memberSession);
      expect(res.status).toBe(200);
      expect((await res.json()).revoked_connections).toBeGreaterThanOrEqual(1);
      expect(await tokenWorks(direct.access_token)).toBe(false);
      const listed = await (await listAs(memberSession)).json();
      expect(listed.issuers[0].connect).toEqual({ window_expires_at: null, connections: [] });

      // Nothing binds now: the window closed with the disconnect.
      const again = await (await present(await mint(sub, MEMBER_EMAIL))).json();
      registrations.add(again.registration_id);
      expect(again.error).toBe("interaction_required");
      expect(await auditFor("team.idjag_connect_disconnected")).toContainEqual(
        expect.objectContaining({ outcome: "ok", target_id: issuerId })
      );
    });

    it("accepts a short-lived assertion without auth_time or email_verified, not a long one", async () => {
      expect((await openWindow(memberSession)).status).toBe(200);
      const sub = `relaxed-${RUN}`;
      const long = await present(await mint(sub, MEMBER_EMAIL, { authTime: false, ttl: 301 }));
      expect(await long.json()).toMatchObject({
        error: "invalid_grant",
        error_description: expect.stringContaining("exp - iat"),
      });
      const unverified = await present(await mint(sub, MEMBER_EMAIL, { emailVerified: false }));
      expect((await unverified.json()).error).toBe("invalid_grant");

      const relaxed = await present(
        await mint(sub, MEMBER_EMAIL, { authTime: false, emailVerified: null })
      );
      expect(relaxed.status).toBe(200);
      const { data: row } = await admin
        .from("agent_registrations")
        .select("id")
        .eq("idjag_iss", ISS)
        .eq("idjag_sub", sub)
        .is("revoked_at", null)
        .single();
      registrations.add(row!.id);
      expect(await tokenWorks((await relaxed.json()).access_token)).toBe(true);
    });

    it("lists the issuers for a member's API key, and never adds or connects with one", async () => {
      const apiKey = `whcc_${randomBytes(24).toString("hex")}`;
      const { error } = await admin.from("api_keys").insert({
        user_id: memberId,
        key_hash: hashApiKey(apiKey),
        key_prefix: apiKey.slice(0, 12),
        name: "ID-JAG list test",
      });
      if (error) throw error;
      try {
        const listed = await listAs(apiKey);
        expect(listed.status).toBe(200);
        expect(await listed.json()).toMatchObject({
          issuers: [{ id: issuerId, issuer: ISS }],
          can_manage: false,
        });
        expect((await addIssuer(apiKey, { issuer: `${ISS}-2` })).status).toBe(403);
        expect((await openWindow(apiKey)).status).toBe(403);
        expect((await disconnect(apiKey)).status).toBe(403);

        // A key of someone outside the team sees nothing.
        const { data: outsider } = await admin
          .from("users")
          .select("id")
          .eq("email", OUTSIDER_EMAIL)
          .single();
        const otherKey = `whcc_${randomBytes(24).toString("hex")}`;
        await admin.from("api_keys").insert({
          user_id: outsider!.id,
          key_hash: hashApiKey(otherKey),
          key_prefix: otherKey.slice(0, 12),
          name: "ID-JAG list test",
        });
        expect((await listAs(otherKey)).status).toBe(404);
      } finally {
        await admin.from("api_keys").delete().eq("name", "ID-JAG list test");
      }
    });
  });

  it("fetched the issuer's keys through the outbound sender", () => {
    expect(fetched).toContain(`${ISS}/.well-known/openid-configuration`);
  });
});
