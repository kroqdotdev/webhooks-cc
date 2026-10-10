import * as jose from "jose";
import { SupabaseClient } from "@supabase/supabase-js";
import { publicEnv, serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { getJwksResolver, getTrustedProvider } from "./trusted-providers";

/**
 * ID-JAG (Identity Assertion JWT Authorization Grant) verification for the
 * agent auth.md `identity_assertion` flow, plus the Security Event Tokens
 * (RFC 8417) providers push to events_endpoint.
 *
 * Verification is synchronous and JWKS-based (no callbacks to the provider):
 *   1. typ + alg check (untrusted header)
 *   2. trusted issuer lookup (env-configured, see trusted-providers.ts)
 *   3. signature + audience (`${NEXT_PUBLIC_APP_URL}/api/`) + exp/iat/nbf
 *   4. jti replay protection (durable, via agent_idjag_jti — Postgres is the
 *      source of truth; a unique-violation means replay)
 *   5. auth_time freshness (auth.md v0.5), then the verified email/phone gate
 *
 * Errors map to the auth.md error catalog so the route can return them verbatim.
 */

const ID_JAG_TYP = "oauth-id-jag+jwt";
const SET_TYP = "secevent+jwt";
/** Clock skew tolerance for exp/iat/nbf (seconds). */
const CLOCK_TOLERANCE_SECS = 120;
/** An ID-JAG is meant to live minutes; one issued earlier than this is refused. */
const ID_JAG_MAX_AGE = "1h";
/**
 * A Security Event Token usually has no `exp`. One issued earlier than this
 * is refused, and its jti is remembered this long, so a captured SET cannot
 * be replayed later against a delegation linked again since.
 */
const SET_MAX_AGE_SECS = 24 * 60 * 60;
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
  | "missing_verified_email"
  | "auth_time_missing"
  | "auth_time_too_old";

export interface IdJagSuccess {
  ok: true;
  sub: string;
  iss: string;
  clientId: string | null;
  email?: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  name?: string;
  /** When the user last signed in at the provider (epoch seconds). */
  authTime: number;
}

export interface IdJagFailure {
  ok: false;
  error: IdJagError;
  /** For auth_time_too_old: how old the sign-in was, in seconds. */
  authAge?: number;
}

export type IdJagResult = IdJagSuccess | IdJagFailure;

/** The audience an assertion must target: the protected resource (`/api/`). */
export function expectedResource(): string {
  return `${publicEnv().NEXT_PUBLIC_APP_URL}/api/`;
}

/** auth.md v0.5: a sign-in at the provider older than this needs a fresh one. */
export function maxAuthAgeSeconds(): number {
  return serverEnv().AGENT_IDJAG_MAX_AUTH_AGE_SECONDS;
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
export async function recordJti(
  jti: string,
  issuer: string,
  purpose: "id-jag" | "set",
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

/** True when this issuer's Security Event Token with this jti was processed. */
export async function securityEventSeen(jti: string, issuer: string): Promise<boolean> {
  const { count, error } = await jtiClient()
    .from("agent_idjag_jti")
    .select("jti", { count: "exact", head: true })
    .eq("jti", jti)
    .eq("issuer", issuer)
    .eq("purpose", "set");
  if (error) throw error;
  return (count ?? 0) > 0;
}

interface VerifyOptions {
  expectedTyp: string;
  audience: string | string[];
  maxTokenAge: string | number;
  /** ID-JAGs are consumed here; SETs leave it to the caller. */
  consumeJti: "id-jag" | null;
}

interface Verified {
  ok: true;
  payload: jose.JWTPayload;
  iss: string;
  jti: string;
  /** Epoch seconds the jti must be remembered until. */
  retainUntil: number;
}

/**
 * Shared trust path: decode header, resolve the trusted provider, verify the
 * signature/audience/expiry, and (for ID-JAGs) consume the jti. Returns the
 * verified payload on success.
 */
async function verifyTrusted(
  jwt: string,
  opts: VerifyOptions
): Promise<Verified | { ok: false; error: IdJagError }> {
  // 1. Decode the (untrusted) header to read typ + alg + the claimed issuer.
  let header: jose.ProtectedHeaderParameters;
  let unverified: jose.JWTPayload;
  try {
    header = jose.decodeProtectedHeader(jwt);
    unverified = jose.decodeJwt(jwt);
  } catch {
    return { ok: false, error: "invalid_token" };
  }

  // RFC 7515 4.1.9: an "application/" prefix on typ is implied and may be sent.
  const typ =
    typeof header.typ === "string" ? header.typ.toLowerCase().replace(/^application\//, "") : "";
  if (typ !== opts.expectedTyp) {
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
      audience: opts.audience,
      algorithms: provider.algs,
      clockTolerance: CLOCK_TOLERANCE_SECS,
      // Requires iat, and refuses one too old or in the future.
      maxTokenAge: opts.maxTokenAge,
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
  let retainUntil: number;
  if (opts.consumeJti) {
    if (exp === null) {
      return { ok: false, error: "credential_expired" };
    }
    retainUntil = exp;
    const fresh = await recordJti(jti, iss, opts.consumeJti, exp);
    if (!fresh) {
      return { ok: false, error: "replay_detected" };
    }
  } else {
    // maxTokenAge made iat a number. Remembered until it would be refused as
    // too old anyway, or until its exp when that comes later.
    retainUntil = Math.max((result.payload.iat as number) + SET_MAX_AGE_SECS, exp ?? 0);
  }

  return { ok: true, payload: result.payload, iss, jti, retainUntil };
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
    // A missing, stale or future iat (maxTokenAge).
    if (err.claim === "iat") {
      return "credential_expired";
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
    audience: expectedResource(),
    maxTokenAge: ID_JAG_MAX_AGE,
    consumeJti: "id-jag",
  });
  if (!verified.ok) {
    return { ok: false, error: verified.error };
  }

  const { payload, iss } = verified;
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  if (!sub) {
    return { ok: false, error: "invalid_token" };
  }

  // auth.md v0.5: the user must have signed in at the provider recently, even
  // for an identity linked long ago, so a provider session cannot be ridden
  // forever. Checked before anything is looked up or created.
  const authTime =
    typeof payload.auth_time === "number" && Number.isFinite(payload.auth_time)
      ? payload.auth_time
      : null;
  if (authTime === null) {
    return { ok: false, error: "auth_time_missing" };
  }
  const authAge = Math.floor(Date.now() / 1000) - authTime;
  if (authAge < -CLOCK_TOLERANCE_SECS) {
    return { ok: false, error: "invalid_token" };
  }
  if (authAge > maxAuthAgeSeconds()) {
    return { ok: false, error: "auth_time_too_old", authAge };
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
    authTime,
  };
}

export interface SecurityEventSuccess {
  ok: true;
  iss: string;
  sub: string;
  jti: string;
  retainUntil: number;
  events: Record<string, unknown>;
}

export type SecurityEventResult = SecurityEventSuccess | IdJagFailure;

/**
 * Verify a Security Event Token (RFC 8417) through the same trust path as an
 * ID-JAG. Its audience is this service, as the issuer or the resource. The
 * jti is not consumed here: the receiver records it once the event has been
 * processed, so a delivery that failed or is still running is never
 * acknowledged on its behalf.
 */
export async function verifySecurityEvent(jwt: string): Promise<SecurityEventResult> {
  const verified = await verifyTrusted(jwt, {
    expectedTyp: SET_TYP,
    audience: [publicEnv().NEXT_PUBLIC_APP_URL, expectedResource()],
    maxTokenAge: SET_MAX_AGE_SECS,
    consumeJti: null,
  });
  if (!verified.ok) {
    return { ok: false, error: verified.error };
  }

  const { payload } = verified;
  const sub = typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  const events = payload.events;
  if (!sub || !events || typeof events !== "object" || Array.isArray(events)) {
    return { ok: false, error: "invalid_token" };
  }

  return {
    ok: true,
    iss: verified.iss,
    sub,
    jti: verified.jti,
    retainUntil: verified.retainUntil,
    events: events as Record<string, unknown>,
  };
}
