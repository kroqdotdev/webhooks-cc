import * as jose from "jose";
import { publicEnv, serverEnv } from "@/lib/env";
import { isCaptureDomainAddress } from "@/lib/email-capture";
import { isPlainEmailAddress } from "@/lib/request-validation";
import { createAdminClient } from "@/lib/supabase/admin";
import { isInboundDomainAddress } from "@/lib/supabase/inbound-domains";
import { newAttemptSecrets, type ClaimAttempt } from "./claims";
import {
  MAX_CLAIM_ATTEMPTS,
  MAX_CONNECTED_AGENTS,
  UNCLAIMED_LIFETIME_SECONDS,
  USER_CODE_TTL_SECONDS,
} from "./constants";
import { maxAuthAgeSeconds, recordJti } from "./id-jag";
import { issuerTrustedByAnyTeam, issuerUnderPrefix, orgIssuersEnabled } from "./org-issuers";
import { OrgJwksError, orgKeyResolver } from "./org-jwks";
import {
  generateClaimToken,
  issueClaimedAccessToken,
  hashClaimToken,
  type AccessToken,
  type RegistrationRow,
} from "./registrations";

/**
 * Organisation ID-JAGs at the token endpoint: the jwt-bearer grant (RFC
 * 7523) with an Identity Assertion JWT Authorization Grant as the assertion,
 * from an issuer a team trusts (lib/agent/org-issuers.ts, migration 00105).
 *
 * Sources, read 2026-11-14:
 * - draft-ietf-oauth-identity-assertion-authz-grant-06 (31 October 2026),
 *   https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/
 *   Section 3: `typ` MUST be `oauth-id-jag+jwt`; iss, sub, aud, client_id,
 *   jti, exp and iat are REQUIRED; auth_time and email are OPTIONAL;
 *   email_verified is not defined. Section 4.4.1: `aud` is the resource
 *   authorization server's issuer identifier, a string or a one-element
 *   array; `client_id` must identify the client; failures are invalid_grant,
 *   a valid assertion for someone not authorized here is access_denied.
 *   Section 4.4.4: jti may be accepted only once; no refresh token.
 * - Claude's Enterprise Managed Auth for connectors,
 *   https://claude.com/docs/connectors/building/enterprise-managed-auth and
 *   https://support.claude.com/en/articles/15537633: Team and Enterprise
 *   plans, Claude-issued assertions in beta; issuer
 *   `https://identity.anthropic.com/issuers/<issuer-id>`, one per
 *   organisation; ES256; keys from the issuer's
 *   /.well-known/openid-configuration jwks_uri; `aud` is our authorization
 *   server's issuer; each assertion expires within a minute and has a new
 *   jti; `email` is always present (the Claude account's, lower-cased) and
 *   users are matched by it; no DCR, the client must be known beforehand.
 *   The pages are silent on `auth_time` and `email_verified`.
 *
 * Since Claude's pages do not say whether `auth_time` and `email_verified`
 * are sent, this path (issuers under AGENT_IDJAG_ORG_ISSUER_PREFIXES only;
 * the ID-JAG path of /api/agent/identity keeps its stricter rules) treats
 * them so:
 * - `auth_time`, when present, must be recent
 *   (AGENT_IDJAG_MAX_AUTH_AGE_SECONDS). When absent, the assertion must be
 *   short-lived: `exp - iat` at most 5 minutes (Claude's expire within a
 *   minute), so it was minted for this sign-in. `jti` stays single-use.
 * - `email_verified` absent is accepted (Claude's `email` is the account's
 *   own); an explicit `false`, or any value but `true`, is refused.
 * Only ES256 is accepted.
 *
 * Every check runs before anything is looked up by email, and the trust
 * check (an issuer some team trusts, under a configured prefix) runs before
 * any key is fetched, so an arbitrary `iss` never makes us fetch anything.
 * A failure before the signature holds is marked unsigned: the grant answers
 * all of those alike, so nobody learns whether a team trusts an issuer.
 */

const ID_JAG_TYP = "oauth-id-jag+jwt";
/** The one algorithm accepted; `none`, HMAC and RSA are refused before any key work. */
const ALGORITHM = "ES256";
/** At most this much clock skew (Claude's docs allow 60 seconds). */
const CLOCK_TOLERANCE_SECS = 60;
/** An assertion issued earlier than this is refused whatever its exp. */
const MAX_TOKEN_AGE = "10m";
/** Without auth_time, an assertion may live at most this long (exp - iat). */
export const MAX_LIFETIME_WITHOUT_AUTH_TIME_SECS = 300;

export type OrgIdJagError =
  | "feature_disabled"
  | "invalid_token"
  | "unsupported_algorithm"
  | "issuer_not_allowed"
  | "invalid_issuer"
  | "keys_unavailable"
  | "unknown_key"
  | "invalid_signature"
  | "invalid_audience"
  | "credential_expired"
  | "not_yet_valid"
  | "replay_detected"
  | "lifetime_too_long"
  | "auth_time_too_old"
  | "client_mismatch"
  | "missing_verified_email";

export interface OrgIdJagSuccess {
  ok: true;
  iss: string;
  sub: string;
  clientId: string;
  /** Verified and lower-cased. */
  email: string;
  /** Null when the assertion carries none (then it was short-lived). */
  authTime: number | null;
}

export type OrgIdJagFailure = {
  ok: false;
  error: OrgIdJagError;
  /** True once the signature held: only then may the answer say why. */
  signed?: true;
  authAge?: number;
};

export type OrgIdJagResult = OrgIdJagSuccess | OrgIdJagFailure;

/** True when the JWT's header says it is an ID-JAG (decoded, not verified). */
export function looksLikeIdJag(jwt: string): boolean {
  try {
    const header = jose.decodeProtectedHeader(jwt);
    return normalizedTyp(header.typ) === ID_JAG_TYP;
  } catch {
    return false;
  }
}

function normalizedTyp(typ: unknown): string {
  // RFC 7515 4.1.9: an "application/" prefix on typ is implied and may be sent.
  return typeof typ === "string" ? typ.toLowerCase().replace(/^application\//, "") : "";
}

/**
 * The issuer of an assertion that goes down the organisation path, read
 * without verifying anything, or null: one under a configured prefix and
 * never our own issuer. Our own assertions carry `typ: oauth-id-jag+jwt`
 * too, so the typ cannot tell them apart; the issuer can. Picks both the
 * token endpoint's path and its rate limit before the signature is checked,
 * without a database lookup.
 */
export function orgIssuerCandidate(jwt: string): string | null {
  if (!orgIssuersEnabled()) return null;
  let iss: unknown;
  try {
    iss = jose.decodeJwt(jwt).iss;
  } catch {
    return null;
  }
  if (typeof iss !== "string" || iss.length > 512) return null;
  if (iss === publicEnv().NEXT_PUBLIC_APP_URL) return null;
  return issuerUnderPrefix(iss) ? iss : null;
}

/**
 * A name for the client an assertion names, for Connected agents and the
 * team page: the host of a client id that is a URL, else the id itself.
 */
export function orgClientName(clientId: string): string {
  try {
    const url = new URL(clientId);
    if (url.protocol === "https:" || url.protocol === "http:") return url.host.slice(0, 200);
  } catch {
    // Not a URL: an opaque client id.
  }
  return clientId.slice(0, 200);
}

/** The audiences we answer to: our authorization server's issuer, or the API. */
export function orgAudiences(): string[] {
  const app = publicEnv().NEXT_PUBLIC_APP_URL;
  return [app, `${app}/api/`];
}

function mapVerifyError(err: unknown): OrgIdJagFailure {
  if (err instanceof OrgJwksError) return { ok: false, error: "keys_unavailable" };
  if (err instanceof jose.errors.JWKSNoMatchingKey) return { ok: false, error: "unknown_key" };
  if (err instanceof jose.errors.JOSEAlgNotAllowed) {
    return { ok: false, error: "unsupported_algorithm" };
  }
  // jose checks the claims only after the signature holds.
  if (err instanceof jose.errors.JWTExpired) {
    return { ok: false, error: "credential_expired", signed: true };
  }
  if (err instanceof jose.errors.JWTClaimValidationFailed) {
    if (err.claim === "aud") return { ok: false, error: "invalid_audience", signed: true };
    if (err.claim === "nbf") return { ok: false, error: "not_yet_valid", signed: true };
    if (err.claim === "iat") {
      // Missing iat is malformed; a stale or future one is expired or early.
      return {
        ok: false,
        error: err.reason === "missing" ? "invalid_token" : "credential_expired",
        signed: true,
      };
    }
    return { ok: false, error: "invalid_token", signed: true };
  }
  return { ok: false, error: "invalid_signature" };
}

/**
 * Verifies an organisation ID-JAG presented by `clientId` (the token
 * request's client_id). Consumes its jti once the signature checks out.
 */
export async function verifyOrgIdJag(jwt: string, clientId: string): Promise<OrgIdJagResult> {
  if (!orgIssuersEnabled()) return { ok: false, error: "feature_disabled" };

  let header: jose.ProtectedHeaderParameters;
  let unverified: jose.JWTPayload;
  try {
    header = jose.decodeProtectedHeader(jwt);
    unverified = jose.decodeJwt(jwt);
  } catch {
    return { ok: false, error: "invalid_token" };
  }
  if (normalizedTyp(header.typ) !== ID_JAG_TYP) return { ok: false, error: "invalid_token" };
  // Before anything is looked up: `none`, HS256 and RS256 never get further.
  if (header.alg !== ALGORITHM) return { ok: false, error: "unsupported_algorithm" };

  const iss = typeof unverified.iss === "string" ? unverified.iss : null;
  if (!iss) return { ok: false, error: "invalid_token" };
  if (!issuerUnderPrefix(iss)) return { ok: false, error: "issuer_not_allowed" };
  // Exact match against what a team owner added, before any key is fetched.
  if (!(await issuerTrustedByAnyTeam(iss))) return { ok: false, error: "invalid_issuer" };

  let payload: jose.JWTPayload;
  try {
    const result = await jose.jwtVerify(jwt, orgKeyResolver(iss), {
      issuer: iss,
      audience: orgAudiences(),
      algorithms: [ALGORITHM],
      clockTolerance: CLOCK_TOLERANCE_SECS,
      maxTokenAge: MAX_TOKEN_AGE,
      requiredClaims: ["exp", "iat", "jti", "sub"],
    });
    payload = result.payload;
  } catch (err) {
    return mapVerifyError(err);
  }
  // From here on the signature holds.
  const fail = (error: OrgIdJagError, authAge?: number): OrgIdJagFailure =>
    authAge === undefined
      ? { ok: false, error, signed: true }
      : { ok: false, error, signed: true, authAge };

  // Section 4.4.1: one audience, as a string or a one-element array.
  if (Array.isArray(payload.aud) && payload.aud.length !== 1) {
    return fail("invalid_audience");
  }
  const jti = typeof payload.jti === "string" && payload.jti ? payload.jti : null;
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  const sub = typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  if (!jti || exp === null || !sub || jti.length > 256 || sub.length > 256) {
    return fail("invalid_token");
  }
  // Consumed as soon as the signature holds, so a replay is always flagged.
  if (!(await recordJti(jti, iss, "id-jag", exp))) {
    return fail("replay_detected");
  }

  let authTime: number | null = null;
  if (payload.auth_time !== undefined) {
    if (typeof payload.auth_time !== "number" || !Number.isFinite(payload.auth_time)) {
      return fail("invalid_token");
    }
    authTime = payload.auth_time;
    const authAge = Math.floor(Date.now() / 1000) - authTime;
    if (authAge < -CLOCK_TOLERANCE_SECS) return fail("invalid_token");
    if (authAge > maxAuthAgeSeconds()) {
      return fail("auth_time_too_old", authAge);
    }
  } else {
    // No auth_time: only an assertion minted for this exchange will do.
    const iat = typeof payload.iat === "number" ? payload.iat : null;
    if (iat === null || exp - iat > MAX_LIFETIME_WITHOUT_AUTH_TIME_SECS) {
      return fail("lifetime_too_long");
    }
  }

  // Section 4.4.1: the client_id claim identifies the client asking.
  if (typeof payload.client_id !== "string" || payload.client_id !== clientId) {
    return fail("client_mismatch");
  }

  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  // Absent is accepted; false (or anything but true) is not.
  if (!email || (payload.email_verified !== undefined && payload.email_verified !== true)) {
    return fail("missing_verified_email");
  }

  return { ok: true, iss, sub, clientId, email, authTime };
}

export type OrgIdJagLink =
  | {
      status: "linked";
      registration: RegistrationRow;
      teamId: string | null;
      token: AccessToken;
      /** True when a member's open window bound the identity just now. */
      bound: boolean;
      /** The trust row whose window bound it. */
      trustId: string | null;
    }
  | {
      status: "interaction_required";
      registration: RegistrationRow;
      teamId: string | null;
      claimToken: string;
      attempt: ClaimAttempt;
      created: boolean;
    }
  | {
      status:
        | "not_member"
        | "client_not_allowed"
        | "identity_mismatch"
        | "email_not_usable"
        | "too_many_attempts"
        | "too_many_pending"
        | "too_many_agents";
    };

async function readRegistration(id: string): Promise<RegistrationRow> {
  const { data, error } = await createAdminClient()
    .from("agent_registrations")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Links a verified organisation assertion to a member of a team that trusts
 * its issuer (link_team_idjag_identity(), migration 00105). Never creates an
 * account: a person who is not a member is refused. Inside a window the
 * member opened on the team page, the first assertion binds at once;
 * otherwise the first use answers interaction_required with a claim
 * ceremony. Once bound, later assertions for the same identity get an
 * access token at once.
 */
export async function linkOrgIdJag(verified: OrgIdJagSuccess): Promise<OrgIdJagLink> {
  const email = verified.email;
  // Mail to the capture domain, or to a verified inbound domain, can be read
  // through webhooks.cc itself, so it never identifies anyone.
  if (
    !isPlainEmailAddress(email) ||
    isCaptureDomainAddress(email, serverEnv().EMAIL_CAPTURE_DOMAIN) ||
    (await isInboundDomainAddress(email))
  ) {
    return { status: "email_not_usable" };
  }

  const claimToken = generateClaimToken();
  const secrets = newAttemptSecrets();
  const { data, error } = await createAdminClient().rpc("link_team_idjag_identity", {
    p_iss: verified.iss,
    p_sub: verified.sub,
    p_email: email,
    p_client_id: verified.clientId,
    p_client_name: orgClientName(verified.clientId),
    p_claim_token_hash: hashClaimToken(claimToken),
    p_attempt_token_hash: secrets.attemptTokenHash,
    p_user_code_hash: secrets.userCodeHash,
    p_lifetime_seconds: UNCLAIMED_LIFETIME_SECONDS,
    p_attempt_seconds: USER_CODE_TTL_SECONDS,
    p_max_attempts: MAX_CLAIM_ATTEMPTS,
    p_max_pending: serverEnv().AGENT_MAX_PENDING_PER_LOGIN_HINT,
    p_max_agents: MAX_CONNECTED_AGENTS,
  });
  if (error) throw error;
  const result = data as {
    status: string;
    registration_id?: string;
    team_id?: string | null;
    trust_id?: string | null;
    created?: boolean;
    bound?: boolean;
    attempt?: number;
    attempt_expires_at?: string;
  };

  switch (result.status) {
    case "linked": {
      const registration = await readRegistration(result.registration_id!);
      // A one-hour token only, never an assertion of ours: the next token
      // takes a fresh ID-JAG. The registration is read again and the token
      // capped as for the jwt-bearer grant.
      const token = await issueClaimedAccessToken(registration.id);
      return {
        status: "linked",
        registration,
        teamId: result.team_id ?? null,
        token,
        bound: result.bound === true,
        trustId: result.trust_id ?? null,
      };
    }
    case "pending": {
      const registration = await readRegistration(result.registration_id!);
      return {
        status: "interaction_required",
        registration,
        teamId: result.team_id ?? null,
        claimToken,
        created: result.created === true,
        attempt: {
          registrationId: registration.id,
          kind: "identity_assertion",
          attemptToken: secrets.attemptToken,
          attemptTokenHash: secrets.attemptTokenHash,
          userCode: secrets.userCode,
          expiresAt: new Date(result.attempt_expires_at!),
          attempt: result.attempt!,
        },
      };
    }
    case "not_member":
    case "client_not_allowed":
    case "identity_mismatch":
    case "too_many_attempts":
    case "too_many_pending":
    case "too_many_agents":
      return { status: result.status };
    default:
      throw new Error(`Unexpected link_team_idjag_identity status: ${result.status}`);
  }
}
