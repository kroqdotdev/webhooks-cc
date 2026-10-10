/**
 * Fixed numbers of agent registration (auth.md v0.6). Pure, so the discovery
 * builders and /auth.md quote the same values the routes enforce.
 */

/** An unclaimed registration, its assertion and its sandbox live this long. */
export const UNCLAIMED_LIFETIME_SECONDS = 24 * 60 * 60;
/** An access token lives this long, and never past an unclaimed registration. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** A claimed registration's assertion; the human repeats the claim after it. */
export const CLAIMED_ASSERTION_TTL_SECONDS = 90 * 24 * 60 * 60;
/** Live access tokens per registration; an exchange beyond it drops the oldest. */
export const MAX_LIVE_TOKENS = 5;

/** Live sandbox endpoints per registration. */
export const SANDBOX_MAX_ENDPOINTS = 3;
/** Captures per sandbox endpoint (check_and_increment_ephemeral). */
export const SANDBOX_REQUESTS_PER_ENDPOINT = 25;
/** Captures per registration across its endpoints (agent_registrations default). */
export const SANDBOX_REQUEST_BUDGET = 100;
/** Requests a sandbox list returns at most. */
export const SANDBOX_MAX_LIST = 100;

/** A proof-of-work challenge is valid this long. */
export const POW_CHALLENGE_TTL_SECONDS = 300;
/** Clients refuse more expected work than 2^26 hashes; we never ask for more. */
export const POW_MAX_WORK_BITS = 26;
export const POW_ALGORITHM = "sha256-zero-bits";

export const PRE_CLAIM_SCOPES = ["webhooks:sandbox"];
export const POST_CLAIM_SCOPES = ["webhooks:read", "webhooks:write"];

export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
export const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";
export const ID_JAG_ASSERTION_TYPE = "urn:ietf:params:oauth:token-type:id-jag";

/** Longest client_name kept; the column allows 64. */
export const MAX_CLIENT_NAME = 64;

/** A claim attempt's code lives this long (D14: covers sign-up with email confirmation). */
export const USER_CODE_TTL_SECONDS = 15 * 60;
/** Seconds an agent waits between claim polls (RFC 8628 interval). */
export const CLAIM_POLL_INTERVAL_SECONDS = 5;
/** Attempts a registration may start; each replaces the one before. */
export const MAX_CLAIM_ATTEMPTS = 10;
/** Wrong codes that end an attempt. */
export const MAX_CODE_FAILURES = 5;
/** Connected (claimed, unrevoked) agents per account (D7). */
export const MAX_CONNECTED_AGENTS = 10;

/**
 * The auth.md v0.1 verified_email flow is deprecated from the v0.6 claim
 * ceremony on and removed after the sunset (RFC 9745, RFC 8594).
 */
export const VERIFIED_EMAIL_DEPRECATED_AT = "2026-10-10T00:00:00Z";
export const VERIFIED_EMAIL_SUNSET_AT = "2026-11-30T00:00:00Z";
