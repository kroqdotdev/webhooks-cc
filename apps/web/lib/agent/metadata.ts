import { publicEnv } from "@/lib/env";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  ASSERTION_REVOKED_EVENT,
  CLAIM_GRANT,
  CLAIMED_ASSERTION_TTL_SECONDS,
  CLAIM_POLL_INTERVAL_SECONDS,
  DEFAULT_IDJAG_MAX_AUTH_AGE_SECONDS,
  MAX_CLAIM_ATTEMPTS,
  MAX_CODE_FAILURES,
  MAX_CONNECTED_AGENTS,
  USER_CODE_TTL_SECONDS,
  VERIFIED_EMAIL_SUNSET_AT,
  ID_JAG_ASSERTION_TYPE,
  JWT_BEARER_GRANT,
  MAX_LIVE_TOKENS,
  POST_CLAIM_SCOPES,
  POW_ALGORITHM,
  POW_CHALLENGE_TTL_SECONDS,
  POW_MAX_WORK_BITS,
  PRE_CLAIM_SCOPES,
  SANDBOX_MAX_ENDPOINTS,
  SANDBOX_MAX_LIST,
  SANDBOX_REQUEST_BUDGET,
  SANDBOX_REQUESTS_PER_ENDPOINT,
  UNCLAIMED_LIFETIME_SECONDS,
} from "./constants";

/**
 * Discovery documents and /auth.md for agent registration (WorkOS auth.md
 * v0.6). Pure builders: URLs come from NEXT_PUBLIC_APP_URL and numbers from
 * ./constants, so the routes and the unit test share one source. Whether an
 * ID-JAG issuer is trusted is passed in by the route.
 */

export interface AgentMetadataOptions {
  /** True when AGENT_IDJAG_PROVIDERS trusts at least one issuer. */
  idJagEnabled: boolean;
  /** AGENT_IDJAG_MAX_AUTH_AGE_SECONDS, quoted in /auth.md. */
  idJagMaxAuthAgeSeconds?: number;
}

/** Resource identifier of the protected API (the audience of an ID-JAG). */
function resourceUrl(appUrl: string): string {
  return `${appUrl}/api/`;
}

function urls(appUrl: string) {
  return {
    resource: resourceUrl(appUrl),
    authMd: `${appUrl}/auth.md`,
    prm: `${appUrl}/.well-known/oauth-protected-resource`,
    asMetadata: `${appUrl}/.well-known/oauth-authorization-server`,
    jwks: `${appUrl}/.well-known/jwks.json`,
    identity: `${appUrl}/api/agent/identity`,
    challenge: `${appUrl}/api/agent/identity/challenge`,
    claim: `${appUrl}/api/agent/identity/claim`,
    token: `${appUrl}/api/oauth2/token`,
    revoke: `${appUrl}/api/oauth2/revoke`,
    events: `${appUrl}/api/agent/event/notify`,
    sandbox: `${appUrl}/api/agent/sandbox/endpoints`,
    sandboxRequest: `${appUrl}/api/agent/sandbox/requests`,
    docs: `${appUrl}/docs/agents`,
  };
}

const SCOPES = [...PRE_CLAIM_SCOPES, ...POST_CLAIM_SCOPES];

/**
 * Absolute URL of the hosted `/auth.md`, for the root `<link rel="auth.md">`
 * so probing agents find it without first triggering a 401.
 */
export function buildAuthMdUrl(): string {
  return `${publicEnv().NEXT_PUBLIC_APP_URL}/auth.md`;
}

// ---------------------------------------------------------------------------
// RFC 9728 Protected Resource Metadata
// ---------------------------------------------------------------------------

export interface ProtectedResourceMetadata {
  resource: string;
  resource_name: string;
  resource_logo_uri: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  resource_documentation: string;
  scopes_supported: string[];
}

/** Served at `/.well-known/oauth-protected-resource`. */
export function buildProtectedResourceMetadata(): ProtectedResourceMetadata {
  const appUrl = publicEnv().NEXT_PUBLIC_APP_URL;
  return {
    resource: resourceUrl(appUrl),
    resource_name: "webhooks.cc",
    resource_logo_uri: `${appUrl}/icon-512.png`,
    // Must equal the AS metadata `issuer` (no trailing slash).
    authorization_servers: [appUrl],
    bearer_methods_supported: ["header"],
    resource_documentation: `${appUrl}/auth.md`,
    // Advisory: what an unclaimed token reaches is decided by the routes.
    scopes_supported: SCOPES,
  };
}

// ---------------------------------------------------------------------------
// RFC 8414 Authorization Server Metadata with the auth.md `agent_auth` block
// ---------------------------------------------------------------------------

export interface AgentAuthMetadata {
  skill: string;
  identity_endpoint: string;
  claim_endpoint: string;
  events_endpoint: string;
  identity_types_supported: string[];
  identity_assertion?: { assertion_types_supported: string[] };
  events_supported: string[];
  anonymous: {
    credential_types_supported: string[];
    proof_of_work: { challenge_endpoint: string; algorithms_supported: string[] };
    sandbox: {
      endpoints_url: string;
      lifetime_seconds: number;
      max_endpoints: number;
      max_requests_per_endpoint: number;
      max_requests: number;
    };
  };
  register_uri: string;
  claim_uri: string;
}

export interface AuthorizationServerMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  issuer: string;
  token_endpoint: string;
  revocation_endpoint: string;
  jwks_uri: string;
  grant_types_supported: string[];
  service_documentation: string;
  agent_auth: AgentAuthMetadata;
}

/** Served at `/.well-known/oauth-authorization-server`. */
export function buildAuthorizationServerMetadata(
  options: AgentMetadataOptions
): AuthorizationServerMetadata {
  const appUrl = publicEnv().NEXT_PUBLIC_APP_URL;
  const u = urls(appUrl);

  return {
    // The PRM, restated (auth.md Step 1b).
    resource: u.resource,
    authorization_servers: [appUrl],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],

    issuer: appUrl,
    token_endpoint: u.token,
    revocation_endpoint: u.revoke,
    jwks_uri: u.jwks,
    grant_types_supported: [JWT_BEARER_GRANT, CLAIM_GRANT],
    service_documentation: u.authMd,
    agent_auth: {
      skill: u.authMd,
      identity_endpoint: u.identity,
      claim_endpoint: u.claim,
      // Where trusted ID-JAG providers push Security Event Tokens (RFC 8935).
      events_endpoint: u.events,
      // An agent only tries identity_assertion when it is listed (AUTH.md Step 2).
      identity_types_supported: options.idJagEnabled
        ? ["anonymous", "service_auth", "identity_assertion"]
        : ["anonymous", "service_auth"],
      ...(options.idJagEnabled
        ? { identity_assertion: { assertion_types_supported: [ID_JAG_ASSERTION_TYPE] } }
        : {}),
      events_supported: [ASSERTION_REVOKED_EVENT],
      anonymous: {
        credential_types_supported: ["access_token"],
        // Our extensions; generic clients ignore unknown members.
        proof_of_work: {
          challenge_endpoint: u.challenge,
          algorithms_supported: [POW_ALGORITHM],
        },
        sandbox: {
          endpoints_url: u.sandbox,
          lifetime_seconds: UNCLAIMED_LIFETIME_SECONDS,
          max_endpoints: SANDBOX_MAX_ENDPOINTS,
          max_requests_per_endpoint: SANDBOX_REQUESTS_PER_ENDPOINT,
          max_requests: SANDBOX_REQUEST_BUDGET,
        },
      },
      // Pre-v0.2 names, kept because agent-readiness scanners still look
      // for them (auth.md issue #16). `anonymous.credential_types_supported`
      // above is there for the same reason.
      register_uri: u.identity,
      claim_uri: u.claim,
    },
  };
}

// ---------------------------------------------------------------------------
// Hosted /auth.md
// ---------------------------------------------------------------------------

function hours(seconds: number): string {
  return `${seconds / 3600} hours`;
}

/**
 * The hosted `/auth.md`: auth.md v0.6's Steps 1 to 6 with our values, plus
 * the proof of work and the sandbox, which are webhooks.cc extensions.
 */
export function buildAuthMd(options: AgentMetadataOptions): string {
  const appUrl = publicEnv().NEXT_PUBLIC_APP_URL;
  const u = urls(appUrl);
  const maxAuthAge = options.idJagMaxAuthAgeSeconds ?? DEFAULT_IDJAG_MAX_AUTH_AGE_SECONDS;

  return `# webhooks.cc agent registration (auth.md)

You are an agent. webhooks.cc implements [auth.md v0.6](https://github.com/workos/auth.md)
agent registration. Without an account you can register anonymously, solve a
short proof of work, and use a sandbox: capture webhooks on up to
${SANDBOX_MAX_ENDPOINTS} temporary endpoints and read them back. When your
human wants to keep them, or you need their account, run the claim ceremony:
they sign in and type a code you show them. Follow the steps in order.

Human-readable guide: ${u.docs}

## At a glance

| Item | Value |
| --- | --- |
| Unclaimed registration, its identity assertion and its sandbox | ${hours(UNCLAIMED_LIFETIME_SECONDS)} |
| Access token | ${ACCESS_TOKEN_TTL_SECONDS / 60} minutes, never past the registration; at most ${MAX_LIVE_TOKENS} live per registration |
| Sandbox endpoints | ${SANDBOX_MAX_ENDPOINTS} at a time, each living until the registration expires |
| Sandbox captures | ${SANDBOX_REQUESTS_PER_ENDPOINT} per endpoint, ${SANDBOX_REQUEST_BUDGET} per registration |
| Proof-of-work challenge | valid ${POW_CHALLENGE_TTL_SECONDS / 60} minutes, single use |
| Claim code (\`user_code\`) | ${USER_CODE_TTL_SECONDS / 60} minutes, ${MAX_CODE_FAILURES} wrong tries; ${MAX_CLAIM_ATTEMPTS} attempts per registration |
| Claimed assertion | ${CLAIMED_ASSERTION_TTL_SECONDS / 86400} days |
| Connected agents per account | ${MAX_CONNECTED_AGENTS} |
| Anonymous registrations | 5 per hour per IP address |

## Step 1: Discover

- Protected Resource Metadata: ${u.prm}
- Authorization Server Metadata: ${u.asMetadata}
- Signing keys of our identity assertions: ${u.jwks}

A 401 from the API carries \`WWW-Authenticate: Bearer resource_metadata="..."\`
pointing at the first document. The \`agent_auth\` block in the second one
lists the endpoints below.

## Step 2: Pick a method

- **anonymous**: you have neither. Gives you the sandbox right away; a
  claim is optional.
- **service_auth**: you have only your user's email. Nothing works until
  they complete the claim ceremony; no proof of work and no sandbox:

  \`\`\`http
  POST ${u.identity}
  Content-Type: application/json

  { "type": "service_auth", "login_hint": "user@example.com", "client_name": "my-agent" }
  \`\`\`

  The response carries \`registration_id\`, \`claim_url\`, \`claim_token\`,
  \`claim_token_expires\`, \`post_claim_scopes\` and the first claim attempt as
  \`claim: { user_code, expires_in, verification_uri, interval }\`. Continue
  at Step 4b.
- **identity_assertion** (ID-JAG): ${
    options.idJagEnabled
      ? `accepted from the issuers this deployment trusts. The assertion needs an
  \`auth_time\` within the last ${maxAuthAge} seconds, else the answer is 401
  \`login_required\`: have your user sign in at your provider again and mint a
  fresh ID-JAG. When its verified email belongs to an existing account that
  has not linked your provider identity yet, the answer is 401
  \`interaction_required\` with the same fields as a service_auth
  registration: continue at Step 4b. Once the human confirms, the next ID-JAG
  for the same identity registers directly.`
      : "no identity provider is trusted yet; it answers `issuer_not_enabled`."
  }

## Step 3: Register (anonymous)

Anonymous registration needs a solved proof-of-work challenge. Get one:

\`\`\`http
POST ${u.challenge}
\`\`\`

\`\`\`json
{
  "challenge": "pow1.eyJ2Ijox...",
  "algorithm": "${POW_ALGORITHM}",
  "difficulty": 18,
  "count": 32,
  "expires_at": "2026-10-10T10:05:00.000Z"
}
\`\`\`

For each \`i\` from 0 to \`count - 1\`, find a decimal nonce (at most 16
digits) such that SHA-256 of the UTF-8 string \`<challenge>.<i>.<nonce>\`
starts with \`difficulty\` zero bits. Expected work is \`count x 2^difficulty\`
hashes; difficulty rises by a bit or two while the sandbox is busy, and never
past 2^${POW_MAX_WORK_BITS} hashes in all. A plain solver like these takes
roughly 5 to 15 seconds on one core.

Python:

\`\`\`python
import hashlib

def solve(challenge: str, difficulty: int, count: int) -> list[str]:
    nonces = []
    for i in range(count):
        n = 0
        while int.from_bytes(hashlib.sha256(f"{challenge}.{i}.{n}".encode()).digest(), "big") >> (256 - difficulty):
            n += 1
        nonces.append(str(n))
    return nonces
\`\`\`

JavaScript (Node.js):

\`\`\`js
import { createHash } from "node:crypto";

function solve(challenge, difficulty, count) {
  const nonces = [];
  for (let i = 0; i < count; i++) {
    let n = 0;
    while (BigInt("0x" + createHash("sha256").update(\`\${challenge}.\${i}.\${n}\`).digest("hex")) >> BigInt(256 - difficulty)) n++;
    nonces.push(String(n));
  }
  return nonces;
}
\`\`\`

Then register:

\`\`\`http
POST ${u.identity}
Content-Type: application/json

{
  "type": "anonymous",
  "client_name": "my-agent",
  "proof_of_work": { "challenge": "pow1.eyJ2Ijox...", "nonces": ["81723", "40211", "..."] }
}
\`\`\`

\`client_name\` is optional (at most 64 characters) and is shown to humans as
self-reported. Without \`proof_of_work\` the answer is 400
\`proof_of_work_required\` with a fresh challenge in the body, so two calls are
enough even without discovery. Response (200):

\`\`\`json
{
  "registration_id": "<uuid>",
  "registration_type": "anonymous",
  "identity_assertion": "<service-signed JWT>",
  "assertion_expires": "<24 hours from now>",
  "pre_claim_scopes": ${JSON.stringify(PRE_CLAIM_SCOPES)},
  "claim_url": "${u.claim}",
  "claim_token": "clm_...",
  "claim_token_expires": "<24 hours from now>",
  "post_claim_scopes": ${JSON.stringify(POST_CLAIM_SCOPES)},
  "sandbox": { "status": "available", "endpoints_url": "${u.sandbox}", ... }
}
\`\`\`

\`sandbox.status\` is \`full\` when the shared sandbox has no free endpoint
slot; ask a human to sign up instead. The response also repeats these values
in the nested shape of the auth.md v0.7 proposal (\`id\`, \`type\`,
\`identity\`, \`claim\`, \`scopes\`).

\`claim_token\` is returned once. Keep it in memory for Step 4; do not persist
it.

## Step 4: Claim ceremony

A human with a webhooks.cc account (or who signs up) connects you to it.
For an anonymous registration this moves your sandbox endpoints, with what
they captured, into their account and replaces your sandbox token with
account credentials.

### 4a. Start an attempt

service_auth: the \`claim\` block of your Step 3 response is your first
attempt. anonymous:

\`\`\`http
POST ${u.claim}
Content-Type: application/json

{ "claim_token": "clm_...", "email": "user@example.com" }
\`\`\`

\`\`\`json
{
  "registration_id": "<uuid>",
  "claim_attempt_id": "cla_...",
  "status": "initiated",
  "expires_at": "<${USER_CODE_TTL_SECONDS / 60} minutes from now>",
  "claim_attempt": {
    "user_code": "123456",
    "expires_in": ${USER_CODE_TTL_SECONDS},
    "verification_uri": "${appUrl}/agent/claim?attempt=cat_...",
    "interval": ${CLAIM_POLL_INTERVAL_SECONDS}
  }
}
\`\`\`

\`email\` binds the attempt: only someone signed in with that address can
complete it. The same call starts a new attempt when a code ran out (a
service_auth registration may leave \`email\` out); the previous link stops
working. A registration may start ${MAX_CLAIM_ATTEMPTS} attempts.

### 4b. Hand off to the human

Show both in one message, for example:

> Open this link, sign in (or sign up), and enter this 6-digit code: **123456**
> ${appUrl}/agent/claim?attempt=cat_...

The code goes into the page, not back to you. The page shows the human your
\`client_name\` (labelled as self-reported), when you registered and which
sandbox endpoints will move, and lets them decline.

### 4c. Poll for completion

\`\`\`http
POST ${u.token}
Content-Type: application/x-www-form-urlencoded

grant_type=${CLAIM_GRANT}
&claim_token=clm_...
\`\`\`

| Answer | Meaning |
| --- | --- |
| \`authorization_pending\` | Not done yet. Poll again after \`interval\` seconds. |
| \`slow_down\` | You polled faster than \`interval\`. Wait longer. |
| \`expired_token\` | The code ran out (or ${MAX_CODE_FAILURES} wrong codes were entered). Start a new attempt (4a); if that answers \`claim_expired\`, register again. |
| \`access_denied\` | The human declined. |
| \`invalid_grant\` | Unknown, revoked or already collected claim token. |

Success is an OAuth token response plus a claimed identity assertion:

\`\`\`json
{
  "access_token": "whcc_...",
  "token_type": "Bearer",
  "expires_in": ${ACCESS_TOKEN_TTL_SECONDS},
  "scope": "${POST_CLAIM_SCOPES.join(" ")}",
  "identity_assertion": "<service-signed JWT>",
  "assertion_expires": "<${CLAIMED_ASSERTION_TTL_SECONDS / 86400} days from now>"
}
\`\`\`

The claim token works once: the first successful poll uses it up, so keep
the response. Your pre-claim tokens and assertion stop working. The access
token acts for the human on the whole API (\`${u.resource}\`), except
account settings such as API keys and billing. Mint new ones from the
claimed assertion (Step 5); when it expires, the human repeats the claim.

## Step 5: Exchange the assertion

\`\`\`http
POST ${u.token}
Content-Type: application/x-www-form-urlencoded

grant_type=${JWT_BEARER_GRANT}
&assertion=<identity_assertion>
&resource=${u.resource}
\`\`\`

Response (200):

\`\`\`json
{ "access_token": "whcc_...", "token_type": "Bearer", "expires_in": ${ACCESS_TOKEN_TTL_SECONDS}, "scope": "${PRE_CLAIM_SCOPES.join(" ")}" }
\`\`\`

A claimed assertion (Step 4c) gets \`"scope": "${POST_CLAIM_SCOPES.join(" ")}"\`
instead. The same assertion mints new tokens until it expires. \`invalid_grant\` means
the registration expired or was revoked: register again (Step 3). There is
no refresh token.

## Step 6: Use the access token

Send \`Authorization: Bearer whcc_...\`. A claimed agent's token works on the
whole API at \`${u.resource}\` (except account settings such as API keys and
billing). An unclaimed registration's token works only on the sandbox:

| Call | Result |
| --- | --- |
| \`POST ${u.sandbox}\` | 201, a new endpoint with its capture \`url\`. 409 \`sandbox_endpoint_limit\` at ${SANDBOX_MAX_ENDPOINTS} live; 503 \`sandbox_full\` when the shared pool is full. |
| \`GET ${u.sandbox}\` | This registration's live endpoints and its remaining budget. |
| \`GET ${u.sandbox}/{slug}\` | One endpoint; 404 when it is not this registration's. |
| \`DELETE ${u.sandbox}/{slug}\` | 204. Frees a slot; the request budget is not refunded. |
| \`GET ${u.sandbox}/{slug}/requests?since=<ms>&limit=<n>\` | Captured requests, newest first, at most ${SANDBOX_MAX_LIST}. |
| \`GET ${u.sandboxRequest}/{id}\` | One captured request. |

Send webhooks to the endpoint's \`url\` (\`https://go.webhooks.cc/w/<slug>\`).
Each endpoint stores ${SANDBOX_REQUESTS_PER_ENDPOINT} requests and the
registration ${SANDBOX_REQUEST_BUDGET} in all; past that the capture URL
answers 429. Sandbox endpoints answer every capture with a plain 200: there
are no mock responses, notifications, signature checks, email or forwarding.
Only this registration's token can read its captures.

On a 401 with a previously working token, exchange the assertion again
(Step 5) once; if that returns \`invalid_grant\`, register again.

## Revocation

- \`POST ${u.revoke}\` with \`token=<access_token>\` (form-encoded) drops one
  access token. Always 200. Your assertion still works.
- Every token, endpoint and capture of an unclaimed registration is deleted
  within minutes after it expires.
- The human can disconnect a claimed agent under Account, Connected agents:
  your tokens stop working and the assertion answers \`invalid_grant\`.
- An identity provider can revoke an ID-JAG identity with a Security Event
  Token at ${u.events}. Its registration and tokens go, and the assertion
  answers \`invalid_grant\`.

## Errors

\`${u.identity}\` and the sandbox answer \`{ "error", "error_description" }\`;
\`${u.token}\` uses the OAuth envelope (RFC 6749).

| Code | Where | What to do |
| --- | --- | --- |
| \`proof_of_work_required\` (400) | identity | Solve the challenge in the body and send it. |
| \`invalid_challenge\` (400) | identity | The proof was wrong, expired or reused. Solve the fresh challenge in the body. |
| \`anonymous_not_enabled\` (400) | identity | Anonymous registration is off. Ask a human to sign up. |
| \`invalid_login_hint\` (400) | identity, claim | Give one plain email address; addresses at the capture domain are refused. |
| \`invalid_claim_token\` (401) | claim | Unknown or revoked claim token. Register again. |
| \`claimed_or_in_flight\` (409) | claim | Already claimed. Poll the claim grant. |
| \`claim_expired\` (410) | claim | The registration expired. Register again. |
| \`too_many_attempts\` (429) | claim | ${MAX_CLAIM_ATTEMPTS} attempts used. Register again. |
| \`issuer_not_enabled\` (400) | identity | Your identity provider is not trusted here. |
| \`login_required\` (401) | identity (ID-JAG) | \`auth_time\` is missing or older than \`max_age\`. Re-authenticate the user at your provider and mint a fresh ID-JAG. |
| \`interaction_required\` (401) | identity (ID-JAG) | The email belongs to an existing account. Run the claim ceremony from Step 4b with the \`claim\` block in the body. |
| \`invalid_request\` (400) | any | Fix the request body. |
| \`rate_limited\` (429) | any | Wait for \`Retry-After\` seconds. |
| \`temporarily_unavailable\` (503) | identity | Retry after \`Retry-After\` seconds. |
| \`invalid_grant\` (400) | token | Register again. |
| \`authorization_pending\`, \`slow_down\`, \`expired_token\`, \`access_denied\` (400) | token, claim grant | See 4c. |
| \`unsupported_grant_type\` (400) | token | Use the jwt-bearer or the claim grant. |
| \`invalid_target\` (400) | token | \`resource\` must be ${u.resource} or left out. |
| \`sandbox_endpoint_limit\` (409) | sandbox | Delete an endpoint first. |
| \`sandbox_full\` (503) | sandbox | Retry later, or ask a human to sign up. |
| \`sandbox_closed\` (403) | sandbox | The registration was claimed, revoked or expired. |
| \`sandbox_only\` (403) | sandbox | The sandbox takes agent tokens, not API keys. |
| \`not_found\` (404) | sandbox | Not this registration's endpoint or request. |

## Older clients (auth.md v0.1)

The v0.1 endpoints under \`${appUrl}/api/agent/auth\` answer 410
\`endpoint_moved\`, except the \`verified_email\` flow, which keeps working for
older SDK and MCP versions until ${VERIFIED_EMAIL_SUNSET_AT.slice(0, 10)}. Its
answers carry \`Deprecation\` and \`Sunset\` headers. New agents should follow
the steps above.

## For identity providers (ID-JAG)

Trusted issuers are deployment configuration (\`AGENT_IDJAG_PROVIDERS\`),
never changeable at runtime. An assertion must use \`typ: oauth-id-jag+jwt\`,
come from a trusted issuer, target audience \`${u.resource}\`, carry a unique
\`jti\`, an \`iat\` within the last hour, an \`auth_time\` within the last
${maxAuthAge} seconds and a verified email (\`email_verified: true\`), and be
unexpired.

An identity \`(iss, sub)\` links to an account in this order: the account it
was linked to before; else, when an account has the verified email, nothing
links until the human signed in to it confirms (\`interaction_required\`);
else a new account is created for the email.

To revoke an identity, POST a Security Event Token (RFC 8417) to
${u.events} with \`Content-Type: application/secevent+jwt\`: \`typ:
secevent+jwt\`, signed with the same keys, \`aud\` \`${appUrl}\`, a unique
\`jti\`, \`iat\` within the last 24 hours, the identity's \`sub\`, and
\`events\` containing \`${ASSERTION_REVOKED_EVENT}\`. Every registration of
that identity is revoked with its tokens, and the next ID-JAG for it links
again as above. The answer is 202 with no body (also for a SET already
received), or 400 with \`{ "err", "description" }\` (RFC 8935).
`;
}
