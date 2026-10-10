/**
 * Shared setup for the agent registration suites (agent-identity,
 * agent-sandbox, agent-auth). Route handlers are called directly with real
 * Requests against the local Supabase stack.
 *
 * Call `configureAgentEnv()` before anything reads serverEnv(): env is
 * parsed once and cached, so the suites import the routes dynamically after
 * it. The assertion signing key and the proof-of-work secret come from
 * .env.local; the difficulty is lowered so registrations solve instantly.
 */
import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function configureAgentEnv(extra: Record<string, string> = {}): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("agent integration tests must not run with NODE_ENV=production");
  }
  if (!process.env.AGENT_ASSERTION_SIGNING_KEY || !process.env.AGENT_POW_SECRET) {
    throw new Error(
      "Set AGENT_ASSERTION_SIGNING_KEY and AGENT_POW_SECRET in .env.local (see .env.example)"
    );
  }
  Object.assign(process.env, {
    AGENT_REGISTER_RATE_LIMIT: "1000",
    AGENT_REGISTER_WIDE_RATE_LIMIT: "100000",
    AGENT_ANONYMOUS_GLOBAL_RATE: "100000",
    AGENT_IDJAG_RATE_LIMIT: "1000",
    AGENT_REGISTER_RATE_WINDOW_MS: "3600000",
    AGENT_MAX_LIVE_ANONYMOUS: "100000",
    AGENT_ANONYMOUS_ENABLED: "true",
    AGENT_POW_DIFFICULTY: "2",
    AGENT_POW_COUNT: "2",
    ...extra,
  });
}

export function adminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** A fresh client address per request, so per-IP limits never cross cases. */
let ipCounter = 0;
export function nextIp(prefix = "198.18"): string {
  ipCounter += 1;
  return `${prefix}.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}`;
}

/** The app URL every issuer, audience and advertised URL is built from. */
export const APP = process.env.NEXT_PUBLIC_APP_URL ?? "https://webhooks.cc";

export function jsonPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${APP}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": nextIp(), ...headers },
    body: JSON.stringify(body),
  });
}

export function formPost(path: string, fields: Record<string, string>) {
  return new Request(`${APP}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": nextIp(),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

export function bearer(method: string, path: string, token: string, body?: unknown): Request {
  return new Request(`${APP}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-forwarded-for": nextIp(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

type Handler = (request: Request) => Promise<Response>;
type ParamHandler<P> = (request: Request, ctx: { params: Promise<P> }) => Promise<Response>;

export interface AgentRoutes {
  identity: Handler;
  challenge: Handler;
  claim: Handler;
  token: Handler;
  revoke: Handler;
  sandboxList: Handler;
  sandboxCreate: Handler;
  sandboxGet: ParamHandler<{ slug: string }>;
  sandboxDelete: ParamHandler<{ slug: string }>;
  sandboxRequests: ParamHandler<{ slug: string }>;
  sandboxRequest: ParamHandler<{ id: string }>;
  solve: (challenge: string, difficulty: number, count: number) => string[];
  serverEnv: () => Record<string, unknown>;
  invalidatePoolUsage: () => void;
}

export async function loadAgentRoutes(): Promise<AgentRoutes> {
  const [
    identity,
    challenge,
    claim,
    token,
    revoke,
    sandbox,
    sandboxSlug,
    requests,
    request,
    pow,
    env,
    registrations,
  ] = await Promise.all([
    import("@/app/api/agent/identity/route"),
    import("@/app/api/agent/identity/challenge/route"),
    import("@/app/api/agent/identity/claim/route"),
    import("@/app/api/oauth2/token/route"),
    import("@/app/api/oauth2/revoke/route"),
    import("@/app/api/agent/sandbox/endpoints/route"),
    import("@/app/api/agent/sandbox/endpoints/[slug]/route"),
    import("@/app/api/agent/sandbox/endpoints/[slug]/requests/route"),
    import("@/app/api/agent/sandbox/requests/[id]/route"),
    import("@/lib/agent/pow"),
    import("@/lib/env"),
    import("@/lib/agent/registrations"),
  ]);
  return {
    identity: identity.POST,
    challenge: challenge.POST,
    claim: claim.POST,
    token: token.POST,
    revoke: revoke.POST,
    sandboxList: sandbox.GET,
    sandboxCreate: sandbox.POST,
    sandboxGet: sandboxSlug.GET,
    sandboxDelete: sandboxSlug.DELETE,
    sandboxRequests: requests.GET,
    sandboxRequest: request.GET,
    solve: pow.solveChallenge,
    serverEnv: () => env.serverEnv() as unknown as Record<string, unknown>,
    invalidatePoolUsage: registrations.invalidatePoolUsage,
  };
}

export interface Registered {
  body: Record<string, unknown> & {
    registration_id: string;
    identity_assertion: string;
    claim_token: string;
  };
  proof: { challenge: string; nonces: string[] };
}

/** Challenge, solve, register. Records the id for cleanup. */
export async function registerAnonymous(
  routes: AgentRoutes,
  created: Set<string>,
  clientName = "integration-agent"
): Promise<Registered> {
  const challengeRes = await routes.challenge(jsonPost("/api/agent/identity/challenge", {}));
  if (challengeRes.status !== 200) {
    throw new Error(`challenge ${challengeRes.status}: ${await challengeRes.text()}`);
  }
  const c = (await challengeRes.json()) as { challenge: string; difficulty: number; count: number };
  const proof = {
    challenge: c.challenge,
    nonces: routes.solve(c.challenge, c.difficulty, c.count),
  };
  const res = await routes.identity(
    jsonPost("/api/agent/identity", {
      type: "anonymous",
      client_name: clientName,
      proof_of_work: proof,
    })
  );
  if (res.status !== 200) throw new Error(`register ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as Registered["body"];
  created.add(body.registration_id);
  return { body, proof };
}

export async function exchange(
  routes: AgentRoutes,
  assertion: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await routes.token(
    formPost("/api/oauth2/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Registers and exchanges: an anonymous agent with a sandbox token. */
export async function sandboxAgent(
  routes: AgentRoutes,
  created: Set<string>,
  clientName?: string
): Promise<{ registrationId: string; token: string; assertion: string }> {
  const { body } = await registerAnonymous(routes, created, clientName);
  const exchanged = await exchange(routes, body.identity_assertion);
  if (exchanged.status !== 200) throw new Error(`exchange ${exchanged.status}`);
  return {
    registrationId: body.registration_id,
    token: exchanged.body.access_token as string,
    assertion: body.identity_assertion,
  };
}

/** Deletes registrations; tokens, endpoints and their requests go with them. */
export async function cleanupRegistrations(
  admin: SupabaseClient,
  created: Set<string>
): Promise<void> {
  if (created.size === 0) return;
  await admin
    .from("agent_registrations")
    .delete()
    .in("id", [...created]);
}

export function slugParams(slug: string) {
  return { params: Promise.resolve({ slug }) };
}
