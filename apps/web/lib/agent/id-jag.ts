import * as jose from "jose";
import { SupabaseClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { getJwksResolver, getTrustedProvider } from "./trusted-providers";

/**
 * ID-JAG (Identity Assertion JWT Authorization Grant) verification for the
 * agent auth.md `identity_assertion` flow, plus `logout+jwt` revocation tokens.
 *
 * Verification is synchronous and JWKS-based (no callbacks to the provider):
 *   1. typ + alg check (untrusted header)
 *   2. trusted issuer lookup (env-configured, see trusted-providers.ts)
 *   3. signature + audience (`${NEXT_PUBLIC_APP_URL}/api/`) + exp/iat/nbf
 *   4. jti replay protection (durable, via agent_idjag_jti — Postgres is the
 *      source of truth; a unique-violation means replay)
 *   5. verified email/phone gate
 *
 * Errors map to the auth.md error catalog so the route can return them verbatim.
 */

const ID_JAG_TYP = "oauth-id-jag+jwt";
const LOGOUT_TYP = "logout+jwt";
/** Clock skew tolerance for exp/iat/nbf (seconds). */
const CLOCK_TOLERANCE_SECS = 120;
/** Extra retention beyond `exp` so a replayed jti is rejected until cleanup. */
const JTI_RETENTION_SECS = 300;
/** Postgres unique-violation SQLSTATE — a duplicate jti (replay). */
const PG_UNIQUE_VIOLATION = "23505";

export type IdJagError =
  | "invalid_token"
  | "invalid_issuer"
  | "invalid_audience"
  | "invalid_signature"
  | "credential_expired"
  | "replay_detected"
  | "missing_verified_email";

export interface IdJagSuccess {
  ok: true;
  sub: string;
  iss: string;
  clientId: string | null;
  email?: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  name?: string;
}

export interface IdJagFailure {
  ok: false;
  error: IdJagError;
}

export type IdJagResult = IdJagSuccess | IdJagFailure;

/** The audience an assertion must target: the protected resource (`/api/`). */
export function expectedResource(): string {
  return `${publicEnv().NEXT_PUBLIC_APP_URL}/api/`;
}

/**
 * Untyped admin client for the new agent_idjag_jti table. The generated
 * Database types do not (yet) include it, so we use the permissive default
 * SupabaseClient typing for these service-role inserts. No behavior change —
 * RLS already blocks all non-service access.
 */
function jtiClient(): SupabaseClient {
  return createAdminClient() as unknown as SupabaseClient;
}

/**
 * Record a jti as seen for replay protection. Returns false when the jti was
 * already recorded (Postgres 23505), which the caller maps to `replay_detected`.
 */
async function recordJti(
  jti: string,
  issuer: string,
  purpose: "id-jag" | "logout",
  expSeconds: number
): Promise<boolean> {
  const expiresAt = new Date((expSeconds + JTI_RETENTION_SECS) * 1000).toISOString();
  const { error } = await jtiClient()
    .from("agent_idjag_jti")
    .insert({ jti, issuer, purpose, expires_at: expiresAt });

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      return false;
    }
    throw error;
  }
  return true;
}

interface VerifyOptions {
  expectedTyp: string;
  purpose: "id-jag" | "logout";
}

/**
 * Shared trust path: decode header, resolve the trusted provider, verify the
 * signature/audience/expiry, and consume the jti. Returns the verified payload
 * on success.
 */
async function verifyTrusted(
  jwt: string,
  opts: VerifyOptions
): Promise<{ ok: true; payload: jose.JWTPayload; iss: string } | { ok: false; error: IdJagError }> {
  // 1. Decode the (untrusted) header to read typ + alg + the claimed issuer.
  let header: jose.ProtectedHeaderParameters;
  let unverified: jose.JWTPayload;
  try {
    header = jose.decodeProtectedHeader(jwt);
    unverified = jose.decodeJwt(jwt);
  } catch {
    return { ok: false, error: "invalid_token" };
  }

  if (header.typ !== opts.expectedTyp) {
    return { ok: false, error: "invalid_token" };
  }

  const iss = typeof unverified.iss === "string" ? unverified.iss : null;
  if (!iss) {
    return { ok: false, error: "invalid_token" };
  }

  // 2. Trusted issuer lookup.
  const provider = getTrustedProvider(iss);
  if (!provider) {
    return { ok: false, error: "invalid_issuer" };
  }

  // Pin algorithm to the provider's allow-list before verifying.
  if (typeof header.alg !== "string" || !provider.algs.includes(header.alg)) {
    return { ok: false, error: "invalid_signature" };
  }

  // 3. Verify signature + audience + temporal claims.
  const resolver = getJwksResolver(provider);
  let result: jose.JWTVerifyResult;
  try {
    result = await jose.jwtVerify(jwt, resolver, {
      issuer: iss,
      audience: expectedResource(),
      algorithms: provider.algs,
      clockTolerance: CLOCK_TOLERANCE_SECS,
    });
  } catch (err) {
    return { ok: false, error: mapVerifyError(err) };
  }

  // 4. Replay protection — require jti and consume it durably.
  const jti = typeof result.payload.jti === "string" ? result.payload.jti : null;
  if (!jti) {
    return { ok: false, error: "invalid_token" };
  }
  const exp = typeof result.payload.exp === "number" ? result.payload.exp : null;
  if (exp === null) {
    return { ok: false, error: "credential_expired" };
  }

  const fresh = await recordJti(jti, iss, opts.purpose, exp);
  if (!fresh) {
    return { ok: false, error: "replay_detected" };
  }

  return { ok: true, payload: result.payload, iss };
}

/** Map a jose verification error to the auth.md error catalog. */
function mapVerifyError(err: unknown): IdJagError {
  if (err instanceof jose.errors.JWTExpired) {
    return "credential_expired";
  }
  if (err instanceof jose.errors.JWTClaimValidationFailed) {
    // Audience / issuer / nbf-style claim mismatches.
    if (err.claim === "aud") {
      return "invalid_audience";
    }
    return "invalid_signature";
  }
  if (
    err instanceof jose.errors.JWSSignatureVerificationFailed ||
    err instanceof jose.errors.JWSInvalid ||
    err instanceof jose.errors.JWKSNoMatchingKey
  ) {
    return "invalid_signature";
  }
  return "invalid_signature";
}

/**
 * Verify an ID-JAG assertion for the identity_assertion flow. On success the
 * caller maps the verified subject/email to a user and mints a credential.
 */
export async function verifyIdJag(jwt: string): Promise<IdJagResult> {
  const verified = await verifyTrusted(jwt, {
    expectedTyp: ID_JAG_TYP,
    purpose: "id-jag",
  });
  if (!verified.ok) {
    return { ok: false, error: verified.error };
  }

  const { payload, iss } = verified;
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  if (!sub) {
    return { ok: false, error: "invalid_token" };
  }

  const email = typeof payload.email === "string" ? payload.email : undefined;
  const emailVerified = payload.email_verified === true;
  const phoneVerified = payload.phone_number_verified === true;
  const name = typeof payload.name === "string" ? payload.name : undefined;
  const clientId =
    typeof payload.client_id === "string"
      ? payload.client_id
      : typeof payload.azp === "string"
        ? payload.azp
        : null;

  // 5. Require a verified email (with an email) or a verified phone.
  if (!((emailVerified && email) || phoneVerified)) {
    return { ok: false, error: "missing_verified_email" };
  }

  return {
    ok: true,
    sub,
    iss,
    clientId,
    // SECURITY: only surface the email when it was actually verified. A
    // phone-verified assertion may still carry an unverified `email` claim;
    // passing it downstream would let an attacker bind/take over an account by
    // an address they do not control. Strip it here so consumers that map users
    // by email only ever see verified addresses.
    email: emailVerified ? email : undefined,
    emailVerified,
    phoneVerified,
    name,
  };
}

export interface LogoutTokenSuccess {
  ok: true;
  sub: string;
  iss: string;
}

export type LogoutTokenResult = LogoutTokenSuccess | IdJagFailure;

/**
 * Verify a `logout+jwt` revocation token via the same trust path (signature by
 * the issuer JWKS, jti replay with purpose `logout`). Only providers call the
 * revocation endpoint.
 */
export async function verifyLogoutToken(jwt: string): Promise<LogoutTokenResult> {
  const verified = await verifyTrusted(jwt, {
    expectedTyp: LOGOUT_TYP,
    purpose: "logout",
  });
  if (!verified.ok) {
    return { ok: false, error: verified.error };
  }

  const sub = typeof verified.payload.sub === "string" ? verified.payload.sub : null;
  if (!sub) {
    return { ok: false, error: "invalid_token" };
  }

  return { ok: true, sub, iss: verified.iss };
}
