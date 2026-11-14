/**
 * @fileoverview OAuth 2.1 for remote MCP clients and the /mcp server:
 * dynamic client registration, the consent routes, the authorization_code
 * and refresh_token grants (PKCE, replay and rotation), revocation, and the
 * MCP transport in both protocol eras.
 *
 * Needs the local Supabase stack with migration 00066. Most cases call the
 * route handlers in this process; the last block connects over HTTP to a
 * running web server at WEB_URL (start it with EMAIL_FORWARDING_WORKER=false),
 * because tools that call the API go over that server's loopback. Run with:
 *   cd apps/web && WEB_URL=http://localhost:3000 npx vitest run --config vitest.config.ts tests/integration/oauth-mcp.test.ts
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  adminClient,
  APP,
  bearer,
  configureAgentEnv,
  formPost,
  jsonPost,
  nextIp,
} from "./agent-helpers";

configureAgentEnv();

const admin = adminClient();
const RUN = Date.now();
const PASSWORD = "TestPassword123!";
const REDIRECT = "http://127.0.0.1/callback";

type Handler = (request: Request) => Promise<Response>;

let register: Handler;
let authorizeGet: Handler;
let authorizePost: Handler;
let token: Handler;
let revoke: Handler;
let registrationsGet: Handler;
let mcp: Handler;
let userId: string;
let session: string;
let clientId: string;
const clients: string[] = [];

function verifierPair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizeParams(challenge: string, redirectUri = "http://127.0.0.1:50123/callback") {
  return {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state: "s1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "webhooks:read webhooks:write",
    resource: `${APP}/mcp`,
  };
}

/** Approves a request as the signed-in human; returns the code and the redirect. */
async function approve(challenge: string) {
  const params = authorizeParams(challenge);
  const res = await authorizePost(
    bearer("POST", "/api/oauth2/authorize", session, { ...params, decision: "approve" })
  );
  expect(res.status).toBe(200);
  const { redirect } = (await res.json()) as { redirect: string };
  const url = new URL(redirect);
  return { code: url.searchParams.get("code")!, url, redirectUri: params.redirect_uri };
}

async function redeem(code: string, verifier: string, redirectUri: string) {
  const res = await token(
    formPost("/api/oauth2/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: clientId,
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function refresh(refreshToken: string) {
  const res = await token(
    formPost("/api/oauth2/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

function mcpRequest(
  accessToken: string | null,
  body: unknown,
  headers: Record<string, string> = {}
): Request {
  return new Request(`${APP}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

interface RpcAnswer {
  result: {
    serverInfo?: { name: string };
    tools: { name: string }[];
    ttlMs?: number;
    cacheScope?: string;
    isError?: boolean;
  };
}

/** A JSON-RPC answer, whether the transport sent JSON or one SSE event. */
async function rpc(res: Response): Promise<RpcAnswer> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

beforeAll(async () => {
  const [registerRoute, authorizeRoute, tokenRoute, revokeRoute, registrationsRoute, mcpRoute] =
    await Promise.all([
      import("@/app/api/oauth2/register/route"),
      import("@/app/api/oauth2/authorize/route"),
      import("@/app/api/oauth2/token/route"),
      import("@/app/api/oauth2/revoke/route"),
      import("@/app/api/agent/registrations/route"),
      import("@/app/mcp/route"),
    ]);
  register = registerRoute.POST;
  authorizeGet = authorizeRoute.GET;
  authorizePost = authorizeRoute.POST;
  token = tokenRoute.POST;
  revoke = revokeRoute.POST;
  registrationsGet = registrationsRoute.GET;
  mcp = mcpRoute.POST;

  const email = `oauth-mcp-${RUN}@webhooks-test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  userId = data.user!.id;
  const anon = createClient(process.env.SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (signInError) throw signInError;
  session = signIn.session!.access_token;
});

afterAll(async () => {
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
  if (clients.length > 0) await admin.from("oauth_clients").delete().in("client_id", clients);
});

describe("OAuth for remote MCP clients", () => {
  it("registers a public client dynamically", async () => {
    const res = await register(
      jsonPost("/api/oauth2/register", {
        client_name: "Acme MCP client",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "client_secret_basic",
      })
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toMatch(/^whoc_[A-Za-z0-9]{32}$/);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body).not.toHaveProperty("client_secret");
    clientId = body.client_id as string;
    clients.push(clientId);

    const refused = await register(
      jsonPost("/api/oauth2/register", { redirect_uris: ["javascript:alert(1)"] })
    );
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("invalid_redirect_uri");
  });

  it("shows the request to the signed-in human, never to an API key", async () => {
    const { challenge } = verifierPair();
    const query = new URLSearchParams(authorizeParams(challenge)).toString();
    const res = await authorizeGet(bearer("GET", `/api/oauth2/authorize?${query}`, session));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      client: { name: "Acme MCP client", verifiedHost: null, kind: "registered" },
      redirectHost: "127.0.0.1:50123",
      scope: "webhooks:read webhooks:write",
    });

    const foreign = new URLSearchParams({
      ...authorizeParams(challenge),
      redirect_uri: "https://evil.example/cb",
    }).toString();
    const shown = await authorizeGet(bearer("GET", `/api/oauth2/authorize?${foreign}`, session));
    expect(shown.status).toBe(400);
    expect(await shown.json()).not.toHaveProperty("redirect");
    // A protocol error is shown too: the page navigates only on a decision.
    const plain = new URLSearchParams({
      ...authorizeParams(challenge),
      code_challenge_method: "plain",
    }).toString();
    const refused = await authorizeGet(bearer("GET", `/api/oauth2/authorize?${plain}`, session));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_request" });

    const noSession = await authorizeGet(
      new Request(`${APP}/api/oauth2/authorize?${query}`, { method: "GET" })
    );
    expect(noSession.status).toBe(401);
  });

  it("returns a declined request to the client with access_denied and iss", async () => {
    const { challenge } = verifierPair();
    const res = await authorizePost(
      bearer("POST", "/api/oauth2/authorize", session, {
        ...authorizeParams(challenge),
        decision: "deny",
      })
    );
    const url = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("iss")).toBe(APP);
  });

  it("spends a code on a wrong verifier", async () => {
    const pair = verifierPair();
    const { code, url, redirectUri } = await approve(pair.challenge);
    expect(code).toMatch(/^whac_/);
    expect(url.searchParams.get("iss")).toBe(APP);
    expect(url.searchParams.get("state")).toBe("s1");

    const wrong = await redeem(code, verifierPair().verifier, redirectUri);
    expect(wrong).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    const again = await redeem(code, pair.verifier, redirectUri);
    expect(again).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
  });

  it("revokes what a code created when the code comes back", async () => {
    const pair = verifierPair();
    const { code, redirectUri } = await approve(pair.challenge);
    const first = await redeem(code, pair.verifier, redirectUri);
    expect(first.status).toBe(200);
    expect(first.body.refresh_token).toMatch(/^whrt_/);

    const replay = await redeem(code, pair.verifier, redirectUri);
    expect(replay.body.error).toBe("invalid_grant");
    expect((await refresh(first.body.refresh_token)).body.error).toBe("invalid_grant");
    const call = await mcp(
      mcpRequest(first.body.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })
    );
    expect(call.status).toBe(401);
  });

  describe("a connected client", () => {
    let tokens: Record<string, string>;

    beforeAll(async () => {
      const pair = verifierPair();
      const { code, redirectUri } = await approve(pair.challenge);
      const redeemed = await redeem(code, pair.verifier, redirectUri);
      expect(redeemed.status).toBe(200);
      tokens = redeemed.body;
    });

    it("issues whcc_ access tokens with the account scopes, listed as a connected agent", async () => {
      expect(tokens).toMatchObject({
        token_type: "Bearer",
        scope: "webhooks:read webhooks:write",
      });
      expect(tokens.access_token).toMatch(/^whcc_/);
      const res = await registrationsGet(bearer("GET", "/api/agent/registrations", session));
      const agents = (await res.json()) as { kind: string; clientName: string }[];
      expect(agents).toContainEqual(
        expect.objectContaining({ kind: "oauth", clientName: "Acme MCP client" })
      );
    });

    it("rotates the refresh token, and a quick retry of the old one recovers", async () => {
      const rotated = await refresh(tokens.refresh_token);
      expect(rotated.status).toBe(200);
      expect(rotated.body.refresh_token).not.toBe(tokens.refresh_token);
      // A client that lost the response retries with the old token...
      const retry = await refresh(tokens.refresh_token);
      expect(retry.status).toBe(200);
      const next = await refresh(retry.body.refresh_token);
      expect(next.status).toBe(200);
      tokens = { ...tokens, ...next.body };
    });

    it("treats the refresh token a retry superseded as a copy", async () => {
      const pair = verifierPair();
      const { code, redirectUri } = await approve(pair.challenge);
      const own = (await redeem(code, pair.verifier, redirectUri)).body;
      const lost = await refresh(own.refresh_token);
      const retry = await refresh(own.refresh_token);
      expect(retry.status).toBe(200);
      // Whoever holds the superseded token is not the client: the grant ends.
      expect((await refresh(lost.body.refresh_token)).body.error).toBe("invalid_grant");
      expect((await refresh(retry.body.refresh_token)).body.error).toBe("invalid_grant");
    });

    it("revokes the grant when an old refresh token comes back after the grace period", async () => {
      const pair = verifierPair();
      const { code, redirectUri } = await approve(pair.challenge);
      const own = (await redeem(code, pair.verifier, redirectUri)).body;
      const rotated = await refresh(own.refresh_token);
      expect(rotated.status).toBe(200);
      // Age the rotation past the grace period.
      await admin
        .from("agent_registrations")
        .update({ oauth_refreshed_at: new Date(Date.now() - 120_000).toISOString() })
        .eq(
          "oauth_previous_refresh_hash",
          createHash("sha256").update(own.refresh_token).digest("hex")
        );
      expect((await refresh(own.refresh_token)).body.error).toBe("invalid_grant");
      expect((await refresh(rotated.body.refresh_token)).body.error).toBe("invalid_grant");
    });

    it("challenges a call without a token toward the MCP resource metadata", async () => {
      const res = await mcp(mcpRequest(null, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(
        `resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp"`
      );
      const bad = await mcp(
        mcpRequest("whcc_nope", { jsonrpc: "2.0", id: 1, method: "tools/list" })
      );
      expect(bad.status).toBe(401);
      expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
    });

    it("serves a 2025-era client statelessly", async () => {
      const init = await mcp(
        mcpRequest(tokens.access_token, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
        })
      );
      expect(init.status).toBe(200);
      expect(init.headers.get("mcp-session-id")).toBeNull();
      const initBody = await rpc(init);
      expect(initBody.result.serverInfo?.name).toBe("webhooks-cc");

      const list = await mcp(
        mcpRequest(
          tokens.access_token,
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          { "mcp-protocol-version": "2025-11-25" }
        )
      );
      const names = (await rpc(list)).result.tools.map((t) => t.name);
      expect(names).toContain("create_endpoint");
      expect(names).toContain("wait_for_request");
      expect(names).not.toContain("send_to");
      expect(names).not.toContain("replay_request");
    });

    it("serves the 2026-07-28 revision: discovery, per-request _meta, cache hints", async () => {
      const meta = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
      };
      const headers = { "mcp-protocol-version": "2026-07-28" };
      const discover = await mcp(
        mcpRequest(
          tokens.access_token,
          { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } },
          { ...headers, "mcp-method": "server/discover" }
        )
      );
      expect(discover.status).toBe(200);
      const discovered = await rpc(discover);
      expect(JSON.stringify(discovered.result)).toContain("2026-07-28");

      const list = await mcp(
        mcpRequest(
          tokens.access_token,
          { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } },
          { ...headers, "mcp-method": "tools/list" }
        )
      );
      const result = (await rpc(list)).result;
      expect(result.ttlMs).toBe(3_600_000);
      expect(result.cacheScope).toBe("private");
      expect(result.tools.length).toBeGreaterThan(30);

      const call = await mcp(
        mcpRequest(
          tokens.access_token,
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "list_provider_templates", arguments: {}, _meta: meta },
          },
          { ...headers, "mcp-method": "tools/call", "mcp-name": "list_provider_templates" }
        )
      );
      expect(call.status).toBe(200);
      const called = (await rpc(call)).result;
      expect(called.isError).not.toBe(true);
    });

    it("refuses JSON-RPC batches", async () => {
      const res = await mcp(
        mcpRequest(tokens.access_token, [
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
        ])
      );
      expect(res.status).toBe(400);
    });

    it("ends the grant when the client revokes its refresh token", async () => {
      const res = await revoke(formPost("/api/oauth2/revoke", { token: tokens.refresh_token }));
      expect(res.status).toBe(200);
      const call = await mcp(
        mcpRequest(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })
      );
      expect(call.status).toBe(401);
      expect((await refresh(tokens.refresh_token)).body.error).toBe("invalid_grant");
    });
  });
});

/**
 * A client given the MCP server's address with tool settings, over HTTP
 * against a running web server (WEB_URL), as a remote client would connect:
 * the 401's challenge, both metadata documents, registration, consent and
 * the token, then tools through each address. Tool calls reach the API over
 * the server's own loopback, so they need the server.
 */
describe("OAuth for an MCP address with tool settings", () => {
  const WEB = (process.env.WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  // The server names itself by NEXT_PUBLIC_APP_URL (APP); it listens on WEB.
  const local = (url: string) => (url.startsWith(APP) ? `${WEB}${url.slice(APP.length)}` : url);
  const ALL = `${APP}/mcp?tools=all`;
  const TEAMS_READONLY = `${APP}/mcp?tools=core,teams&readonly=1`;

  let asMetadata: Record<string, unknown>;
  let settingsClient: string;

  async function post(
    url: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    const form = headers["content-type"] === "application/x-www-form-urlencoded";
    return fetch(local(url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": nextIp(),
        ...headers,
      },
      body: form
        ? new URLSearchParams(body as Record<string, string>).toString()
        : JSON.stringify(body),
    });
  }

  /** Consent as the signed-in human for `resource`; the code and its verifier. */
  async function consent(resource: string) {
    const pair = verifierPair();
    const params = {
      client_id: settingsClient,
      redirect_uri: "http://127.0.0.1:50124/callback",
      response_type: "code",
      state: "s2",
      code_challenge: pair.challenge,
      code_challenge_method: "S256",
      scope: "webhooks:read webhooks:write",
      resource,
    };
    const shown = await fetch(
      `${WEB}/api/oauth2/authorize?${new URLSearchParams(params).toString()}`,
      { headers: { authorization: `Bearer ${session}`, "x-forwarded-for": nextIp() } }
    );
    expect(shown.status).toBe(200);
    const res = await post(
      `${APP}/api/oauth2/authorize`,
      { ...params, decision: "approve" },
      { authorization: `Bearer ${session}` }
    );
    expect(res.status).toBe(200);
    const redirect = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(redirect.searchParams.get("iss")).toBe(APP);
    return { code: redirect.searchParams.get("code")!, verifier: pair.verifier, params };
  }

  async function exchange(
    grant: { code: string; verifier: string; params: { redirect_uri: string } },
    resource: string
  ) {
    const res = await post(
      asMetadata.token_endpoint as string,
      {
        grant_type: "authorization_code",
        code: grant.code,
        code_verifier: grant.verifier,
        redirect_uri: grant.params.redirect_uri,
        client_id: settingsClient,
        resource,
      },
      { "content-type": "application/x-www-form-urlencoded" }
    );
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  }

  async function call(address: string, accessToken: string, body: Record<string, unknown>) {
    const res = await post(address, body, {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "mcp-protocol-version": "2025-11-25",
    });
    expect(res.status).toBe(200);
    return (await rpc(res)).result;
  }

  async function toolNames(address: string, accessToken: string): Promise<string[]> {
    const result = await call(address, accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    return result.tools.map((tool) => tool.name);
  }

  async function callTool(address: string, accessToken: string, name: string) {
    return call(address, accessToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: {} },
    });
  }

  beforeAll(async () => {
    const up = await fetch(`${WEB}/.well-known/oauth-authorization-server`).catch(() => null);
    if (!up?.ok) {
      throw new Error(
        `Start the web server at ${WEB} (EMAIL_FORWARDING_WORKER=false), or set WEB_URL`
      );
    }
  });

  it("discovers the server from a 401 on the address with settings", async () => {
    const challenged = await post(ALL, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(challenged.status).toBe(401);
    const header = challenged.headers.get("www-authenticate") ?? "";
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1];
    expect(metadataUrl).toBe(`${APP}/.well-known/oauth-protected-resource/mcp?tools=all`);

    // RFC 9728 3.3: the metadata names the address the client was given.
    const prm = (await (await fetch(local(metadataUrl!))).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(ALL);
    expect(prm.authorization_servers).toEqual([APP]);
    expect(prm.scopes_supported).toEqual(["webhooks:read", "webhooks:write"]);
    const plain = (await (
      await fetch(`${WEB}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as Record<string, unknown>;
    expect(plain.resource).toBe(`${APP}/mcp`);

    // An address with a trailing slash never reaches the route: Next.js
    // sends it to /mcp with its query, so the metadata names /mcp.
    const slashed = await fetch(`${WEB}/mcp/?tools=all`, { method: "POST", redirect: "manual" });
    expect(slashed.status).toBe(308);
    expect(new URL(slashed.headers.get("location") ?? "", WEB).pathname).toBe("/mcp");
    expect(new URL(slashed.headers.get("location") ?? "", WEB).search).toBe("?tools=all");

    const issuerUrl = (prm.authorization_servers as string[])[0];
    asMetadata = (await (
      await fetch(local(`${issuerUrl}/.well-known/oauth-authorization-server`))
    ).json()) as Record<string, unknown>;
    expect(asMetadata.issuer).toBe(APP);
    expect(asMetadata.code_challenge_methods_supported).toContain("S256");
    expect(asMetadata.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });

  it("registers a client dynamically", async () => {
    const res = await post(asMetadata.registration_endpoint as string, {
      client_name: "Acme settings client",
      redirect_uris: ["http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
    });
    expect(res.status).toBe(201);
    settingsClient = ((await res.json()) as { client_id: string }).client_id;
    clients.push(settingsClient);
  });

  it("grants a token for the address with settings, good on every address", async () => {
    const grant = await consent(ALL);
    // The code is for the MCP server, whatever its settings.
    const { data } = await admin
      .from("oauth_authorization_codes")
      .select("resource")
      .eq("code_hash", createHash("sha256").update(grant.code).digest("hex"))
      .single();
    expect(data?.resource).toBe(`${APP}/mcp`);

    // Neither the API with settings nor another path is the MCP server, and a
    // resource never carries a fragment (RFC 8707 2).
    for (const resource of [`${APP}/api/?tools=all`, `${APP}/mcpx?tools=all`, `${ALL}#x`]) {
      expect(await exchange(grant, resource)).toMatchObject({
        status: 400,
        body: { error: "invalid_target" },
      });
    }
    const redeemed = await exchange(grant, ALL);
    expect(redeemed.status).toBe(200);
    expect(redeemed.body).toMatchObject({ token_type: "Bearer" });
    expect(redeemed.body.access_token).toMatch(/^whcc_/);
    const accessToken = redeemed.body.access_token;

    const all = await toolNames(ALL, accessToken);
    expect(all).toContain("add_destination");
    expect(all).toContain("create_spreadsheet");
    expect(all).toContain("list_teams");
    const teams = await toolNames(`${APP}/mcp?tools=teams`, accessToken);
    expect(teams).toContain("list_teams");
    expect(teams).toContain("create_endpoint");
    expect(teams).not.toContain("create_spreadsheet");
    expect(teams.length).toBeLessThan(all.length);
    const readOnly = await toolNames(TEAMS_READONLY, accessToken);
    expect(readOnly).toContain("list_teams");
    expect(readOnly).not.toContain("create_team");

    for (const [address, tool] of [
      [ALL, "list_endpoints"],
      [`${APP}/mcp?tools=teams`, "list_teams"],
    ] as const) {
      const result = await callTool(address, accessToken, tool);
      expect(result.isError, `${tool} through ${address}`).not.toBe(true);
    }
  });

  it("refuses an authorization request for a resource with a fragment", async () => {
    const pair = verifierPair();
    for (const resource of [`${ALL}#x`, `${APP}/mcp#x`]) {
      const params = {
        client_id: settingsClient,
        redirect_uri: "http://127.0.0.1:50124/callback",
        response_type: "code",
        state: "s3",
        code_challenge: pair.challenge,
        code_challenge_method: "S256",
        resource,
      };
      const shown = await fetch(
        `${WEB}/api/oauth2/authorize?${new URLSearchParams(params).toString()}`,
        { headers: { authorization: `Bearer ${session}`, "x-forwarded-for": nextIp() } }
      );
      expect(shown.status, resource).toBe(400);
      expect(((await shown.json()) as { error: string }).error).toBe("invalid_target");
    }
  });

  it("grants for the read-only teams address, and the token works on the others", async () => {
    const grant = await consent(TEAMS_READONLY);
    // The token request may name the address with or without its settings.
    const redeemed = await exchange(grant, `${APP}/mcp`);
    expect(redeemed.status).toBe(200);
    const accessToken = redeemed.body.access_token;

    expect(await toolNames(ALL, accessToken)).toContain("create_spreadsheet");
    const result = await callTool(`${APP}/mcp?tools=teams`, accessToken, "list_teams");
    expect(result.isError).not.toBe(true);

    const refreshed = await post(
      asMetadata.token_endpoint as string,
      {
        grant_type: "refresh_token",
        refresh_token: redeemed.body.refresh_token,
        client_id: settingsClient,
        resource: TEAMS_READONLY,
      },
      { "content-type": "application/x-www-form-urlencoded" }
    );
    expect(refreshed.status).toBe(200);
  });
});
