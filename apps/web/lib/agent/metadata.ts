import { publicEnv } from "@/lib/env";

/**
 * Discovery + documentation builders for the agent self-registration protocol
 * (WorkOS auth.md). These functions are PURE — no Response, no DB, no env
 * mutation — so they can be imported by both the discovery/doc routes AND the
 * CI unit test. Every URL derives from `publicEnv().NEXT_PUBLIC_APP_URL`.
 *
 * The protocol advertises THREE registration flows from one register endpoint:
 *   - anonymous            — immediate, unowned whcc_ API key (claimable in-app)
 *   - verified_email       — OTP email; credential withheld until confirmed
 *   - identity_assertion   — ID-JAG (RFC: urn:ietf:params:oauth:token-type:id-jag)
 *
 * Plus an in-app claim ceremony, OTP verification, and provider-initiated
 * `logout+jwt` revocation.
 */

/** Resource identifier for the protected API (matches id-jag audience). */
function resourceUrl(appUrl: string): string {
  return `${appUrl}/api/`;
}

/** The schema URI advertised for the revocation event. */
function revokedEventSchema(appUrl: string): string {
  return `${appUrl}/.well-known/agent-events/revoked`;
}

/**
 * Absolute URL of the hosted `/auth.md` discovery document. Used by the root
 * `<head>` `<link rel="auth.md">` so probing agents can find it without first
 * triggering a 401 (RFC 9728) or reading the well-known docs. Pure (URL from
 * NEXT_PUBLIC_APP_URL) so it is unit-testable under the CI-safe glob.
 */
export function buildAuthMdUrl(): string {
  return `${publicEnv().NEXT_PUBLIC_APP_URL}/auth.md`;
}

// ---------------------------------------------------------------------------
// RFC 9728 — OAuth Protected Resource Metadata
// ---------------------------------------------------------------------------

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  resource_documentation: string;
  scopes_supported: string[];
}

/**
 * RFC 9728 Protected Resource Metadata, served at
 * `/.well-known/oauth-protected-resource`. Points agents at this app as its own
 * authorization server (the auth.md endpoints live here).
 */
export function buildProtectedResourceMetadata(): ProtectedResourceMetadata {
  const appUrl = publicEnv().NEXT_PUBLIC_APP_URL;
  return {
    resource: resourceUrl(appUrl),
    // RFC 8414 authorization server identifier — MUST match the `issuer`
    // returned by buildAuthorizationServerMetadata() (no trailing slash) so a
    // strict client can correlate the two discovery documents.
    authorization_servers: [appUrl],
    bearer_methods_supported: ["header"],
    resource_documentation: `${appUrl}/auth.md`,
    // Advisory scopes in v1 (stored on the key but not enforced at the bearer
    // boundary). Advertised so agents can request them.
    scopes_supported: ["webhooks:read", "webhooks:write"],
  };
}

// ---------------------------------------------------------------------------
// Authorization Server Metadata (+ auth.md `agent_auth` extension block)
// ---------------------------------------------------------------------------

export interface AgentAuthIdentityAssertion {
  assertion_types_supported: string[];
  credential_types_supported: string[];
}

export interface AgentAuthAnonymous {
  credential_types_supported: string[];
}

export interface AgentAuthMetadata {
  identity_types_supported: string[];
  identity_assertion: AgentAuthIdentityAssertion;
  anonymous: AgentAuthAnonymous;
  skill: string;
  register_uri: string;
  claim_uri: string;
  revocation_uri: string;
  events_supported: { type: string; schema: string }[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  service_documentation: string;
  agent_auth: AgentAuthMetadata;
}

/**
 * Authorization Server Metadata, served at
 * `/.well-known/oauth-authorization-server`. The auth.md-specific extension
 * lives under the `agent_auth` key and advertises all three flows, the claim
 * ceremony, the revocation endpoint, and the `revoked` event.
 */
export function buildAuthorizationServerMetadata(): AuthorizationServerMetadata {
  const appUrl = publicEnv().NEXT_PUBLIC_APP_URL;
  const registerUri = `${appUrl}/api/agent/auth`;

  return {
    issuer: appUrl,
    // No interactive OAuth dance — registration is the entry point. These are
    // present for spec-completeness; agents use `agent_auth.register_uri`.
    authorization_endpoint: registerUri,
    token_endpoint: registerUri,
    registration_endpoint: registerUri,
    scopes_supported: ["webhooks:read", "webhooks:write"],
    response_types_supported: ["none"],
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:token-exchange"],
    token_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${appUrl}/auth.md`,
    agent_auth: {
      identity_types_supported: ["anonymous", "verified_email", "identity_assertion"],
      identity_assertion: {
        assertion_types_supported: [
          "urn:ietf:params:oauth:token-type:id-jag",
          "verified_email",
        ],
        credential_types_supported: ["api_key", "access_token"],
      },
      anonymous: {
        credential_types_supported: ["api_key"],
      },
      skill: `${appUrl}/auth.md`,
      register_uri: registerUri,
      claim_uri: `${appUrl}/agent/claim`,
      revocation_uri: `${appUrl}/api/agent/auth/revoke`,
      events_supported: [
        {
          type: "https://schemas.workos.com/auth-md/events/credential.revoked",
          schema: revokedEventSchema(appUrl),
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Hosted /auth.md document
// ---------------------------------------------------------------------------

/**
 * The full hosted `/auth.md` markdown describing how an agent registers,
 * claims, verifies an OTP, asserts an identity, and how providers revoke. Pure
 * string builder (URLs from NEXT_PUBLIC_APP_URL) so the doc route and the unit
 * test share one source of truth.
 */
export function buildAuthMd(): string {
  const appUrl = publicEnv().NEXT_PUBLIC_APP_URL;
  const registerUri = `${appUrl}/api/agent/auth`;
  const claimPage = `${appUrl}/agent/claim`;
  const revocationUri = `${appUrl}/api/agent/auth/revoke`;
  const resource = resourceUrl(appUrl);

  return `# webhooks.cc agent registration (auth.md)

This service implements the [auth.md](https://auth.md) agent-registration
protocol so AI agents can obtain an API credential for [webhooks.cc](${appUrl})
programmatically. Three registration flows are supported, plus an in-app claim
ceremony and provider-initiated revocation.

## Discovery

- Protected Resource Metadata: \`${appUrl}/.well-known/oauth-protected-resource\`
- Authorization Server Metadata: \`${appUrl}/.well-known/oauth-authorization-server\`
- Resource (audience): \`${resource}\`

The credential is a webhooks.cc API key (prefix \`whcc_\`). Send it as
\`Authorization: Bearer whcc_...\` to the API at \`${resource}\`. Scopes are
\`webhooks:read\` and \`webhooks:write\` (advisory in v1 — recorded on the key but
not enforced at the bearer boundary).

## Register

\`POST ${registerUri}\`

The request body selects the flow via \`type\` (the alias \`identity_type\` is
also accepted).

### 1. Anonymous

Returns an unowned API key immediately. The key works right away, but is not yet
bound to a user: account-scoped operations (creating endpoints, listing
requests) require a claimed key and return \`403\` until the in-app claim
ceremony below completes.

\`\`\`json
{ "type": "anonymous", "requested_credential_type": "api_key", "client_name": "my-agent" }
\`\`\`

Response:

\`\`\`json
{
  "registration_id": "<uuid>",
  "registration_type": "anonymous",
  "credential_type": "api_key",
  "credential": "whcc_...",
  "credential_expires": null,
  "scopes": ["webhooks:read", "webhooks:write"],
  "claim_url": "${claimPage}",
  "claim_token": "clm_...",
  "user_code": "ABCD-EFGH",
  "claim_token_expires": "<iso8601>",
  "post_claim_scopes": ["webhooks:read", "webhooks:write"]
}
\`\`\`

The credential works immediately in a bounded sandbox before it is claimed: an
unclaimed key may create ephemeral endpoints and read only its own captured
requests at \`${appUrl}/api/agent/sandbox/endpoints\`. See "Sandbox" below.

### 2. Verified email (OTP)

A 6-digit one-time code is emailed to the address. The credential is WITHHELD
until the code is confirmed.

\`\`\`json
{ "type": "verified_email", "email": "dev@example.com", "client_name": "my-agent" }
\`\`\`

Response (no credential yet):

\`\`\`json
{
  "registration_id": "<uuid>",
  "registration_type": "email-verification",
  "claim_url": "${claimPage}",
  "claim_token": "clm_...",
  "claim_token_expires": "<iso8601>",
  "post_claim_scopes": ["webhooks:read", "webhooks:write"]
}
\`\`\`

Then confirm the OTP at the verify endpoint to receive the credential:

\`POST ${appUrl}/api/agent/auth/claim/verify-otp\`

\`\`\`json
{ "claim_token": "clm_...", "otp": "123456" }
\`\`\`

Response on success:

\`\`\`json
{
  "credential_type": "api_key",
  "credential": "whcc_...",
  "scopes": ["webhooks:read", "webhooks:write"]
}
\`\`\`

The OTP expires in 10 minutes and allows up to 5 attempts.

### 3. Identity assertion (ID-JAG)

This is the \`identity_assertion\` identity type. Present a verified identity
assertion (\`urn:ietf:params:oauth:token-type:id-jag\`) from a trusted provider.
Verified synchronously against the provider's JWKS — no claim ceremony. The
credential is returned immediately, bound to the user matched by (or provisioned
from) the verified email.

\`POST ${registerUri}\` with \`Content-Type: application/jwt\`; the body is the
ID-JAG. The assertion MUST:

- have header \`typ: "oauth-id-jag+jwt"\` and \`alg\` in the provider's allow-list,
- come from a trusted issuer,
- target audience \`${resource}\`,
- be unexpired (with a jti for replay protection),
- carry a verified email (\`email_verified: true\`) or verified phone.

Response on success:

\`\`\`json
{
  "credential_type": "api_key",
  "credential": "whcc_...",
  "credential_expires": null,
  "scopes": ["webhooks:read", "webhooks:write"]
}
\`\`\`

## Claim ceremony (anonymous flow)

A human binds the anonymous key to their webhooks.cc account in-app (NOT via an
email link). This mirrors the CLI device-auth verify page. There are two
equivalent ways for the human to identify the registration; both end at the
same confirm step:

1. **Claim link** — open \`${claimPage}?token=<claim_token>\` while logged in and
   confirm. Hand the human the full \`claim_url\` with the \`claim_token\`.
2. **Claim code** — open \`${claimPage}\` while logged in, type the short
   \`user_code\` (e.g. \`ABCD-EFGH\`) shown by the agent, and confirm. The code is
   read off the agent's output — no copy/paste of a long token needed.

On confirmation the anonymous key is rebound to that account and granted
\`post_claim_scopes\`.

The confirm step is session-authenticated and accepts EITHER input:

\`POST ${appUrl}/api/agent/auth/claim/confirm\` (browser session token) with
\`{ "claim_token": "clm_..." }\` OR \`{ "user_code": "ABCD-EFGH" }\`.

Agents discover the outcome by polling the register/poll endpoint with the
\`claim_token\`; the status transitions \`pending\` -> \`claimed\`. The poll response
echoes \`user_code\` while pending so the agent can re-surface the code to the
human.

## Sandbox (unclaimed credentials)

To make the anonymous credential useful immediately — before it is claimed — an
unclaimed agent key has a narrow, bounded capability surface at
\`${appUrl}/api/agent/sandbox/endpoints\`:

- \`POST\` — create an EPHEMERAL endpoint (capture-only; bounded expiry,
  capacity-capped per key). Returns the endpoint \`url\`, \`slug\`, and \`expiresAt\`.
- \`GET\` — list this key's sandbox endpoints, or \`GET ?slug=<slug>\` to read ONLY
  the requests captured by one of them.

Cross-tenant isolation is strict: an unclaimed key can only ever see endpoints
and requests created under its own credential — never another agent's and never
a real user's. Once the key is claimed it leaves the sandbox and uses the full
\`${resource}\` API. The sandbox does not configure mock responses, notification
URLs, or signing — claim the credential for those.

## Error catalog

All errors return a JSON body \`{ "error": "<code>" }\` with an appropriate HTTP
status:

| Code | Meaning |
| --- | --- |
| \`invalid_request\` | Malformed body or missing required field |
| \`invalid_issuer\` | ID-JAG issuer is not in the trusted set |
| \`invalid_audience\` | ID-JAG \`aud\` is not \`${resource}\` |
| \`invalid_signature\` | ID-JAG signature/claims failed verification |
| \`credential_expired\` | ID-JAG is expired |
| \`replay_detected\` | ID-JAG/logout \`jti\` was already used |
| \`missing_verified_email\` | No verified email or phone in the assertion |
| \`invalid_claim_token\` | Unknown or malformed claim token |
| \`claim_expired\` | Claim/OTP window elapsed |
| \`previously_claimed\` | Claim/OTP already completed |
| \`otp_invalid\` | Wrong OTP (attempt counted) |
| \`otp_expired\` | OTP locked (too many attempts) or expired |
| \`too_many_keys\` | The target account hit its API-key limit |
| \`rate_limited\` | Too many registration/OTP attempts from this client or email |
| \`temporarily_unavailable\` | Too many pending anonymous registrations; retry later |
| \`unsupported_credential_type\` | Requested credential type is not offered (use \`api_key\`) |
| \`invalid_email\` | The supplied email is missing or malformed |
| \`invalid_token\` | An ID-JAG/logout token is malformed or missing required claims |

## For identity providers (ID-JAG onboarding)

To have your assertions accepted by the \`identity_assertion\` flow, you must be
added to webhooks.cc's trusted-provider set. This set is DEPLOYMENT CONFIG (the
\`AGENT_IDJAG_PROVIDERS\` env var, a JSON array) — it is never mutable at runtime,
so a provider cannot self-register. Each entry pins an issuer and how to resolve
its JWKS:

\`\`\`jsonc
[
  {
    // Issuer identifier — MUST be an absolute https URL equal to the JWT "iss".
    "iss": "https://idp.example.com",
    // Optional explicit JWKS endpoint. Defaults to
    // "${"${iss}"}/.well-known/jwks.json" when omitted.
    "jwks_uri": "https://idp.example.com/.well-known/jwks.json",
    // Permitted signing algorithms for this provider (default: ES256, RS256).
    "algs": ["ES256", "RS256"]
  }
]
\`\`\`

JWKS is resolved with caching and a single refetch on a key-id (\`kid\`) miss, so
key rotation is picked up without a redeploy as long as the new key is published
at the same \`jwks_uri\`. Inline static keys are supported for testing via a
\`jwks\` field (a JWK Set object) in place of \`jwks_uri\`.

Your assertion MUST: use header \`typ: "oauth-id-jag+jwt"\` with an \`alg\` in the
allow-list, set \`iss\` to a trusted issuer, target audience \`${resource}\`, carry
a unique \`jti\` (single-use; replays are rejected forever), be unexpired, and
include a verified email (\`email_verified: true\`) or verified phone. An
unverified email never resolves or provisions an account.

## Revocation (providers only)

Trusted identity providers revoke previously issued credentials by POSTing a
\`logout+jwt\` to:

\`POST ${revocationUri}\` with \`Content-Type: application/logout+jwt\`; the body is
the logout token. It is verified via the same trust path (issuer JWKS, \`jti\`
replay with purpose \`logout\`, \`typ: "logout+jwt"\`). On success all credentials
issued for that issuer+subject are revoked. Agents never call this endpoint.
`;
}
