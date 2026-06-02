/**
 * @fileoverview Agent self-registration on-ramp for the webhooks.cc auth.md
 * protocol. These helpers are UNAUTHENTICATED — they let an AI agent obtain its
 * own webhooks.cc API credential before it has one, so they are standalone
 * functions (and static methods on `WebhooksCC`) rather than instance methods
 * (the client constructor requires an apiKey).
 *
 * Three flows, mirroring the hosted `/auth.md` document:
 *   - anonymous       — mint an unowned key immediately, then a human claims it
 *                       in-app (by claim link or short user_code). Poll for the
 *                       claim to complete.
 *   - verified_email  — receive a 6-digit OTP by email, confirm it to mint a key
 *                       bound to that verified address.
 *   - identity_assertion (ID-JAG) — present a verified assertion from a trusted
 *                       provider; a key is returned synchronously.
 *
 * Everything posts JSON to `${baseUrl}/api/agent/auth*`. The default baseUrl is
 * the production app. See `${baseUrl}/auth.md` for the canonical protocol doc.
 */

const DEFAULT_BASE_URL = "https://webhooks.cc";

function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return url.slice(0, end);
}

/** Shared options accepted by every register helper. */
export interface RegisterOptions {
  /** Base URL of the webhooks.cc app (default: https://webhooks.cc). */
  baseUrl?: string;
  /** Human-readable agent name recorded on the issued key (e.g. "my-cli"). */
  clientName?: string;
  /** Request timeout in ms (default: 30000). */
  timeout?: number;
}

/** Result of a successful anonymous registration. */
export interface AnonymousRegistration {
  registrationId: string;
  /** The webhooks.cc API key (prefix whcc_). Works immediately in the sandbox. */
  credential: string;
  scopes: string[];
  /** In-app page a human opens to claim the credential. */
  claimUrl: string;
  /** One-time token; append as ?token=... to claimUrl, or poll with it. */
  claimToken: string;
  /** Short human-typed claim code (e.g. "ABCD-EFGH") for the code-entry path. */
  userCode: string;
  claimTokenExpires: string;
  postClaimScopes: string[];
}

/** Result of beginning the verified_email flow (no credential yet). */
export interface VerifiedEmailChallenge {
  registrationId: string;
  /** Submit this with the emailed OTP to `confirmEmailOtp` / `verifyOtp`. */
  claimToken: string;
  claimUrl: string;
  claimTokenExpires: string;
  postClaimScopes: string[];
}

/** Result of confirming an OTP, or of an ID-JAG assertion: the credential. */
export interface IssuedCredential {
  credential: string;
  credentialType: "api_key";
  scopes: string[];
}

/** Coarse status of an anonymous claim, surfaced by `pollClaim`. */
export type ClaimStatus = "pending" | "claimed" | "expired" | "previously_claimed" | "invalid";

export interface ClaimPoll {
  status: ClaimStatus;
  /** Echoed while pending so the agent can re-surface the code to the human. */
  userCode?: string;
}

/** Short, actionable recovery suggestions keyed by auth.md error code. */
const REGISTER_RECOVERY_HINTS: Record<string, string> = {
  invalid_email: "Provide a valid email address (a single @ with a dotted domain).",
  invalid_request: "Check the request shape against the auth.md docs.",
  unsupported_credential_type: 'Request credential_type "api_key".',
  rate_limited: "Too many attempts — back off and retry (honor any Retry-After).",
  temporarily_unavailable: "The service is briefly at capacity — retry shortly.",
  invalid_claim_token: "The claim token is unknown or malformed — restart registration.",
  claim_expired: "The claim window elapsed — restart registration for a fresh token.",
  previously_claimed: "Already claimed — reuse the issued credential.",
  otp_invalid: "Wrong code — re-check the emailed OTP and try again.",
  otp_expired: "The OTP is locked or expired — restart the verified_email flow.",
  invalid_issuer: "The ID-JAG issuer is not trusted by this service.",
  invalid_audience: "The ID-JAG audience must be this service's resource URL.",
  missing_verified_email: "The assertion must carry a verified email.",
};

/** Thrown when a register endpoint returns a non-2xx response. */
export class AgentRegisterError extends Error {
  /** Short, human-readable recovery suggestion derived from `code`, when known. */
  readonly hint?: string;
  constructor(
    /** Machine-readable auth.md error code (e.g. "invalid_email"), when present. */
    readonly code: string,
    readonly status: number,
    message?: string
  ) {
    const hint = REGISTER_RECOVERY_HINTS[code];
    super(
      message ?? `Agent registration failed: ${code} (HTTP ${status})${hint ? ` — ${hint}` : ""}`
    );
    this.name = "AgentRegisterError";
    this.hint = hint;
  }
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  timeout: number,
  headers?: Record<string, string>
): Promise<{ status: number; json: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${stripTrailingSlashes(baseUrl)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function resolve(opts: RegisterOptions | undefined) {
  return {
    baseUrl: opts?.baseUrl ?? DEFAULT_BASE_URL,
    clientName: opts?.clientName,
    timeout: opts?.timeout ?? 30000,
  };
}

function fail(json: Record<string, unknown>, status: number): never {
  const code = typeof json.error === "string" ? json.error : "unknown_error";
  throw new AgentRegisterError(code, status);
}

/**
 * Extract a required string field from a success response. A malformed response
 * (missing field, wrong type) is treated as a failure via `fail` rather than
 * silently coerced to "undefined".
 */
function requireString(json: Record<string, unknown>, key: string, status: number): string {
  const value = json[key];
  if (typeof value !== "string") fail(json, status);
  return value;
}

/**
 * Anonymous flow: mint an unowned API key immediately. The key works right away
 * in the bounded sandbox (create ephemeral endpoints, read its own requests).
 * Hand the returned `userCode` (or `claimUrl?token=claimToken`) to a human to
 * bind it to a webhooks.cc account; poll with `pollClaim`.
 */
export async function registerAnonymous(
  opts?: RegisterOptions
): Promise<AnonymousRegistration> {
  const { baseUrl, clientName, timeout } = resolve(opts);
  const { status, json } = await postJson(
    baseUrl,
    "/api/agent/auth",
    {
      type: "anonymous",
      requested_credential_type: "api_key",
      ...(clientName ? { client_name: clientName } : {}),
    },
    timeout
  );
  if (status !== 200 || typeof json.credential !== "string") fail(json, status);

  return {
    registrationId: requireString(json, "registration_id", status),
    credential: json.credential as string,
    scopes: (json.scopes as string[]) ?? [],
    claimUrl: requireString(json, "claim_url", status),
    claimToken: requireString(json, "claim_token", status),
    userCode: requireString(json, "user_code", status),
    claimTokenExpires: requireString(json, "claim_token_expires", status),
    postClaimScopes: (json.post_claim_scopes as string[]) ?? [],
  };
}

/**
 * Poll an anonymous claim by its `claimToken` to discover whether a human has
 * bound the key to an account yet. Returns coarse status only (no credential).
 */
export async function pollClaim(
  claimToken: string,
  opts?: RegisterOptions
): Promise<ClaimPoll> {
  const { baseUrl, timeout } = resolve(opts);
  const { status, json } = await postJson(
    baseUrl,
    "/api/agent/auth/claim",
    { claim_token: claimToken },
    timeout
  );

  if (status === 200 && typeof json.status === "string") {
    return {
      status: json.status as ClaimStatus,
      userCode: typeof json.user_code === "string" ? json.user_code : undefined,
    };
  }
  // Map the documented terminal statuses to a status value instead of throwing,
  // so a polling loop can branch on them.
  if (status === 410) return { status: "expired" };
  if (status === 409) return { status: "previously_claimed" };
  if (status === 400 && json.error === "invalid_claim_token") return { status: "invalid" };
  return fail(json, status);
}

/**
 * Poll until an anonymous claim reaches a terminal state (claimed / expired /
 * previously_claimed / invalid) or the deadline elapses. Resolves with the last
 * observed poll. Useful right after handing the user the claim code/link.
 */
export async function waitForClaim(
  claimToken: string,
  opts?: RegisterOptions & { timeoutMs?: number; pollIntervalMs?: number }
): Promise<ClaimPoll> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 5 * 60 * 1000);
  const interval = opts?.pollIntervalMs ?? 2000;
  let last: ClaimPoll = { status: "pending" };
  while (Date.now() < deadline) {
    last = await pollClaim(claimToken, opts);
    if (last.status !== "pending") return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  return last;
}

/**
 * Verified-email flow, step 1: request a 6-digit OTP be emailed to `email`. No
 * credential is returned yet — confirm the OTP with `confirmEmailOtp`.
 */
export async function registerWithEmail(
  email: string,
  opts?: RegisterOptions
): Promise<VerifiedEmailChallenge> {
  const { baseUrl, clientName, timeout } = resolve(opts);
  const { status, json } = await postJson(
    baseUrl,
    "/api/agent/auth",
    {
      type: "verified_email",
      email,
      ...(clientName ? { client_name: clientName } : {}),
    },
    timeout
  );
  if (status !== 200 || typeof json.claim_token !== "string") fail(json, status);

  return {
    registrationId: requireString(json, "registration_id", status),
    claimToken: json.claim_token as string,
    claimUrl: requireString(json, "claim_url", status),
    claimTokenExpires: requireString(json, "claim_token_expires", status),
    postClaimScopes: (json.post_claim_scopes as string[]) ?? [],
  };
}

/**
 * Verified-email flow, step 2: confirm the emailed OTP. On success the API key
 * (bound to the verified address) is returned.
 */
export async function confirmEmailOtp(
  args: { claimToken: string; otp: string },
  opts?: RegisterOptions
): Promise<IssuedCredential> {
  const { baseUrl, timeout } = resolve(opts);
  const { status, json } = await postJson(
    baseUrl,
    "/api/agent/auth/claim/verify-otp",
    { claim_token: args.claimToken, otp: args.otp },
    timeout
  );
  if (status !== 200 || typeof json.credential !== "string") fail(json, status);

  return {
    credential: json.credential as string,
    credentialType: "api_key",
    scopes: (json.scopes as string[]) ?? [],
  };
}

/**
 * Identity-assertion (ID-JAG) flow: present a verified assertion JWT from a
 * trusted provider. The credential is returned synchronously (no claim step).
 */
export async function registerWithIdJag(
  assertion: string,
  opts?: RegisterOptions
): Promise<IssuedCredential> {
  const { baseUrl, timeout } = resolve(opts);
  const { status, json } = await postJson(
    baseUrl,
    "/api/agent/auth",
    {
      type: "identity_assertion",
      assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
      assertion,
    },
    timeout
  );
  if (status !== 200 || typeof json.credential !== "string") fail(json, status);

  return {
    credential: json.credential as string,
    credentialType: "api_key",
    scopes: (json.scopes as string[]) ?? [],
  };
}

/**
 * Static discovery metadata describing how an agent registers. Surfaced via
 * `WebhooksCC.describeRegistration()` and the SDK's `describe()` so an agent
 * with no credential can learn the on-ramp without a network call.
 */
export interface RegistrationDescription {
  protocol: "auth.md";
  documentation: string;
  flows: Record<string, { description: string; method: string }>;
}

export function describeRegistration(baseUrl: string = DEFAULT_BASE_URL): RegistrationDescription {
  const base = stripTrailingSlashes(baseUrl);
  return {
    protocol: "auth.md",
    documentation: `${base}/auth.md`,
    flows: {
      anonymous: {
        description:
          "WebhooksCC.register.anonymous() — mint an unowned whcc_ key immediately; a human claims it in-app via the returned userCode or claimUrl. Works in the sandbox before claiming. Poll with WebhooksCC.register.pollClaim().",
        method: `POST ${base}/api/agent/auth`,
      },
      verified_email: {
        description:
          "WebhooksCC.register.withEmail(email) then WebhooksCC.register.confirmEmailOtp({ claimToken, otp }) — receive a 6-digit OTP by email and confirm it to get a key bound to that address.",
        method: `POST ${base}/api/agent/auth + /api/agent/auth/claim/verify-otp`,
      },
      identity_assertion: {
        description:
          "WebhooksCC.register.withIdJag(assertion) — present a verified ID-JAG assertion from a trusted provider; the key is returned synchronously.",
        method: `POST ${base}/api/agent/auth`,
      },
    },
  };
}
