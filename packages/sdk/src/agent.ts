/**
 * @fileoverview The auth.md v0.6 steps for an agent, one function each
 * (see https://webhooks.cc/auth.md): discover, get and solve a proof-of-work
 * challenge, register (anonymous or service_auth), exchange the identity
 * assertion for an access token, start a claim and poll it, revoke a token.
 *
 * Most callers want `WebhooksCC.sandbox()`, which runs these in order.
 * Everything here is unauthenticated or uses the agent's own assertion and
 * tokens; no API key is involved.
 */
import { solveChallenge, type PowChallenge, type SolveOptions } from "./pow";

const DEFAULT_BASE_URL = "https://webhooks.cc";
const DEFAULT_TIMEOUT = 30_000;
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";

/** Options every step accepts. */
export interface AgentRequestOptions {
  /** Base URL of the webhooks.cc app (default: https://webhooks.cc). */
  baseUrl?: string;
  /** Request timeout in ms (default: 30000). */
  timeout?: number;
}

/** A refused step: `code` is auth.md's or OAuth's error code. */
export class AgentAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly description?: string,
    /** The rest of the error body: a fresh challenge, Retry-After seconds. */
    readonly details: Record<string, unknown> = {}
  ) {
    super(`${code} (HTTP ${status})${description ? `: ${description}` : ""}`);
    this.name = "AgentAuthError";
  }
}

function base(options: AgentRequestOptions): string {
  let url = options.baseUrl ?? DEFAULT_BASE_URL;
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

async function call(
  options: AgentRequestOptions,
  path: string,
  init: { method?: string; json?: unknown; form?: Record<string, string>; token?: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string | undefined;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  }
  if (init.token) headers.Authorization = `Bearer ${init.token}`;

  const response = await fetch(`${base(options)}${path}`, {
    method: init.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
    signal: AbortSignal.timeout(options.timeout ?? DEFAULT_TIMEOUT),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === "object") parsed = value as Record<string, unknown>;
    } catch {
      // Non-JSON bodies only come with errors; the status says enough.
    }
  }
  return { status: response.status, body: parsed };
}

function fail(status: number, body: Record<string, unknown>): AgentAuthError {
  const { error, error_description, ...details } = body;
  return new AgentAuthError(
    typeof error === "string" ? error : `http_${status}`,
    status,
    typeof error_description === "string" ? error_description : undefined,
    details
  );
}

function string(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new Error(`Malformed response: missing ${key}`);
  return value;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface AgentDiscovery {
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  identityEndpoint: string;
  claimEndpoint: string;
  identityTypes: string[];
  grantTypes: string[];
  challengeEndpoint?: string;
  sandboxEndpointsUrl?: string;
}

/** Reads the authorization server metadata (auth.md Step 1b). */
export async function discover(options: AgentRequestOptions = {}): Promise<AgentDiscovery> {
  const { status, body } = await call(options, "/.well-known/oauth-authorization-server", {});
  if (status !== 200) throw fail(status, body);
  const agent = (body.agent_auth ?? {}) as Record<string, unknown>;
  const anonymous = (agent.anonymous ?? {}) as Record<string, Record<string, unknown>>;
  return {
    issuer: string(body, "issuer"),
    tokenEndpoint: string(body, "token_endpoint"),
    revocationEndpoint: string(body, "revocation_endpoint"),
    identityEndpoint: string(agent, "identity_endpoint"),
    claimEndpoint: string(agent, "claim_endpoint"),
    identityTypes: (agent.identity_types_supported as string[] | undefined) ?? [],
    grantTypes: (body.grant_types_supported as string[] | undefined) ?? [],
    challengeEndpoint: anonymous.proof_of_work?.challenge_endpoint as string | undefined,
    sandboxEndpointsUrl: anonymous.sandbox?.endpoints_url as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Proof of work and registration
// ---------------------------------------------------------------------------

/** A fresh proof-of-work challenge for anonymous registration. */
export async function challenge(options: AgentRequestOptions = {}): Promise<PowChallenge> {
  const { status, body } = await call(options, "/api/agent/identity/challenge", { json: {} });
  if (status !== 200) throw fail(status, body);
  return body as unknown as PowChallenge;
}

export interface ClaimAttempt {
  /** Show this to the human together with `verificationUri`. */
  userCode: string;
  /** The page the human opens, signs in on, and enters the code. */
  verificationUri: string;
  expiresAt: Date;
  /** Seconds to wait between claim polls. */
  interval: number;
}

export interface AnonymousRegistration {
  registrationId: string;
  identityAssertion: string;
  assertionExpires: Date;
  /** Keep in memory; it starts a claim and collects its result. */
  claimToken: string;
  claimTokenExpires: Date;
  preClaimScopes: string[];
  postClaimScopes: string[];
  sandbox: {
    /** `full` when the shared sandbox has no free endpoint slot. */
    status: "available" | "full";
    endpointsUrl: string;
    maxEndpoints: number;
    maxRequestsPerEndpoint: number;
    maxRequests: number;
  };
}

export interface RegisterAnonymousOptions extends AgentRequestOptions {
  /** Your agent's name, shown to the human as self-reported (64 characters). */
  clientName?: string;
  /** Passed to the solver: cancel it, or change how often it yields. */
  solve?: SolveOptions;
}

/**
 * Registers anonymously: fetches a challenge, solves it (a few seconds of
 * CPU) and registers. Retries once with a fresh challenge when the server
 * refuses the first (it expired while solving, for example).
 */
export async function registerAnonymous(
  options: RegisterAnonymousOptions = {}
): Promise<AnonymousRegistration> {
  let current = await challenge(options);
  for (let attempt = 0; ; attempt++) {
    const nonces = await solveChallenge(current, options.solve);
    const { status, body } = await call(options, "/api/agent/identity", {
      json: {
        type: "anonymous",
        ...(options.clientName ? { client_name: options.clientName } : {}),
        proof_of_work: { challenge: current.challenge, nonces },
      },
    });
    if (status === 200) return toAnonymousRegistration(body);
    const fresh =
      typeof body.challenge === "string" &&
      (body.error === "invalid_challenge" || body.error === "proof_of_work_required");
    if (attempt === 0 && fresh) {
      current = body as unknown as PowChallenge;
      continue;
    }
    throw fail(status, body);
  }
}

function toAnonymousRegistration(body: Record<string, unknown>): AnonymousRegistration {
  const sandbox = (body.sandbox ?? {}) as Record<string, unknown>;
  return {
    registrationId: string(body, "registration_id"),
    identityAssertion: string(body, "identity_assertion"),
    assertionExpires: new Date(string(body, "assertion_expires")),
    claimToken: string(body, "claim_token"),
    claimTokenExpires: new Date(string(body, "claim_token_expires")),
    preClaimScopes: (body.pre_claim_scopes as string[] | undefined) ?? [],
    postClaimScopes: (body.post_claim_scopes as string[] | undefined) ?? [],
    sandbox: {
      status: sandbox.status === "full" ? "full" : "available",
      endpointsUrl: String(sandbox.endpoints_url ?? ""),
      maxEndpoints: Number(sandbox.max_endpoints ?? 3),
      maxRequestsPerEndpoint: Number(sandbox.max_requests_per_endpoint ?? 25),
      maxRequests: Number(sandbox.max_requests ?? 100),
    },
  };
}

function toClaimAttempt(block: Record<string, unknown>): ClaimAttempt {
  const expiresIn = Number(block.expires_in ?? 0);
  return {
    userCode: string(block, "user_code"),
    verificationUri: string(block, "verification_uri"),
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    interval: Number(block.interval ?? 5),
  };
}

export interface ServiceAuthRegistration {
  registrationId: string;
  claimToken: string;
  claimTokenExpires: Date;
  postClaimScopes: string[];
  /** The first claim attempt: show it to the human now. */
  claim: ClaimAttempt;
}

/**
 * Registers for a human you know by email (service_auth). Nothing works
 * until that human signs in and enters the code; no proof of work.
 */
export async function registerServiceAuth(
  options: AgentRequestOptions & { email: string; clientName?: string }
): Promise<ServiceAuthRegistration> {
  const { status, body } = await call(options, "/api/agent/identity", {
    json: {
      type: "service_auth",
      login_hint: options.email,
      ...(options.clientName ? { client_name: options.clientName } : {}),
    },
  });
  if (status !== 200) throw fail(status, body);
  return {
    registrationId: string(body, "registration_id"),
    claimToken: string(body, "claim_token"),
    claimTokenExpires: new Date(string(body, "claim_token_expires")),
    postClaimScopes: (body.post_claim_scopes as string[] | undefined) ?? [],
    claim: toClaimAttempt((body.claim ?? {}) as Record<string, unknown>),
  };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface AccessToken {
  accessToken: string;
  scope: string;
  /** When the token stops working. */
  expiresAt: Date;
}

/** Exchanges an identity assertion for an access token (auth.md Step 5). */
export async function exchange(
  options: AgentRequestOptions & { assertion: string }
): Promise<AccessToken> {
  const { status, body } = await call(options, "/api/oauth2/token", {
    form: { grant_type: JWT_BEARER_GRANT, assertion: options.assertion },
  });
  if (status !== 200) throw fail(status, body);
  return {
    accessToken: string(body, "access_token"),
    scope: String(body.scope ?? ""),
    expiresAt: new Date(Date.now() + Number(body.expires_in ?? 3600) * 1000),
  };
}

/** Drops one access token (RFC 7009). The assertion keeps working. */
export async function revoke(options: AgentRequestOptions & { token: string }): Promise<void> {
  const { status, body } = await call(options, "/api/oauth2/revoke", {
    form: { token: options.token, token_type_hint: "access_token" },
  });
  if (status !== 200) throw fail(status, body);
}

// ---------------------------------------------------------------------------
// Claim ceremony
// ---------------------------------------------------------------------------

/**
 * Starts a claim attempt (auth.md Step 4a). `email` names the only person
 * who may complete it; a service_auth registration may leave it out.
 * Starting again replaces the previous attempt.
 */
export async function startClaim(
  options: AgentRequestOptions & { claimToken: string; email?: string }
): Promise<ClaimAttempt & { registrationId: string }> {
  const { status, body } = await call(options, "/api/agent/identity/claim", {
    json: {
      claim_token: options.claimToken,
      ...(options.email ? { email: options.email } : {}),
    },
  });
  if (status !== 200) throw fail(status, body);
  return {
    registrationId: string(body, "registration_id"),
    ...toClaimAttempt((body.claim_attempt ?? {}) as Record<string, unknown>),
  };
}

export type ClaimPoll =
  | { status: "pending" | "slow_down" | "expired" | "denied" }
  | {
      status: "claimed";
      token: AccessToken;
      /** The claimed assertion: mint new tokens with it (90 days). */
      identityAssertion: string;
      assertionExpires: Date;
    };

/** One poll of the claim grant (auth.md Step 4c). */
export async function pollClaim(
  options: AgentRequestOptions & { claimToken: string }
): Promise<ClaimPoll> {
  const { status, body } = await call(options, "/api/oauth2/token", {
    form: { grant_type: CLAIM_GRANT, claim_token: options.claimToken },
  });
  if (status === 200) {
    return {
      status: "claimed",
      token: {
        accessToken: string(body, "access_token"),
        scope: String(body.scope ?? ""),
        expiresAt: new Date(Date.now() + Number(body.expires_in ?? 3600) * 1000),
      },
      identityAssertion: string(body, "identity_assertion"),
      assertionExpires: new Date(string(body, "assertion_expires")),
    };
  }
  switch (body.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied" };
    default:
      throw fail(status, body);
  }
}

export interface WaitForClaimOptions extends AgentRequestOptions {
  claimToken: string;
  /** Seconds between polls (default 5, the server's interval). */
  interval?: number;
  /** Give up after this many ms (default: 15 minutes, one code's lifetime). */
  timeout?: number;
  signal?: AbortSignal;
}

/**
 * Polls until the human connects the agent. Resolves with the claimed
 * credentials, or rejects with an AgentAuthError: `expired_token` (start a
 * new attempt), `access_denied`, or `timeout`.
 */
export async function waitForClaim(
  options: WaitForClaimOptions
): Promise<Extract<ClaimPoll, { status: "claimed" }>> {
  let interval = (options.interval ?? 5) * 1000;
  const deadline = Date.now() + (options.timeout ?? 15 * 60_000);
  for (;;) {
    options.signal?.throwIfAborted();
    const result = await pollClaim({ ...options, timeout: undefined });
    if (result.status === "claimed") return result;
    if (result.status === "expired") {
      throw new AgentAuthError("expired_token", 400, "The code expired. Start a new claim.");
    }
    if (result.status === "denied") {
      throw new AgentAuthError("access_denied", 400, "The human declined.");
    }
    if (result.status === "slow_down") interval += 5000;
    if (Date.now() + interval > deadline) {
      throw new AgentAuthError("timeout", 0, "The human did not connect the agent in time.");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
