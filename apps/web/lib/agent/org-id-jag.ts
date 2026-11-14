import * as jose from "jose";
import { publicEnv, serverEnv } from "@/lib/env";
import { isCaptureDomainAddress } from "@/lib/email-capture";
import { isPlainEmailAddress } from "@/lib/request-validation";
import { createAdminClient } from "@/lib/supabase/admin";
import { isInboundDomainAddress } from "@/lib/supabase/inbound-domains";
import { signAssertion } from "./assertion";
import { accountEmail, newAttemptSecrets, type ClaimAttempt } from "./claims";
import {
  CLAIMED_ASSERTION_TTL_SECONDS,
  MAX_CLAIM_ATTEMPTS,
  UNCLAIMED_LIFETIME_SECONDS,
  USER_CODE_TTL_SECONDS,
} from "./constants";
import { maxAuthAgeSeconds, recordJti } from "./id-jag";
import { issuerTrustedByAnyTeam, issuerUnderPrefix, orgIssuersEnabled } from "./org-issuers";
import { OrgJwksError, orgKeyResolver } from "./org-jwks";
import {
  exchangeAssertion,
  generateClaimToken,
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
 * Beyond the draft, this path requires `email_verified: true` and a recent
 * `auth_time`, like the ID-JAG path of /api/agent/identity, and accepts only
 * ES256. An assertion that lacks either is refused (see the PR's open
 * decisions: Claude's pages do not say whether they send them).
 *
 * Every check runs before anything is looked up by email, and the trust
 * check (an issuer some team trusts, under a configured prefix) runs before
 * any key is fetched, so an arbitrary `iss` never makes us fetch anything.
 */

const ID_JAG_TYP = "oauth-id-jag+jwt";
/** The one algorithm accepted; `none`, HMAC and RSA are refused before any key work. */
const ALGORITHM = "ES256";
/** At most this much clock skew (Claude's docs allow 60 seconds). */
const CLOCK_TOLERANCE_SECS = 60;
/** An assertion issued earlier than this is refused whatever its exp. */
const MAX_TOKEN_AGE = "10m";

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
  | "auth_time_missing"
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
  authTime: number;
}

export type OrgIdJagResult =
  OrgIdJagSuccess | { ok: false; error: OrgIdJagError; authAge?: number };

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

/** The audiences we answer to: our authorization server's issuer, or the API. */
export function orgAudiences(): string[] {
  const app = publicEnv().NEXT_PUBLIC_APP_URL;
  return [app, `${app}/api/`];
}

function mapVerifyError(err: unknown): OrgIdJagError {
  if (err instanceof OrgJwksError) return "keys_unavailable";
  if (err instanceof jose.errors.JWKSNoMatchingKey) return "unknown_key";
  if (err instanceof jose.errors.JOSEAlgNotAllowed) return "unsupported_algorithm";
  if (err instanceof jose.errors.JWTExpired) return "credential_expired";
  if (err instanceof jose.errors.JWTClaimValidationFailed) {
    if (err.claim === "aud") return "invalid_audience";
    if (err.claim === "nbf") return "not_yet_valid";
    if (err.claim === "iat") {
      // Missing iat is malformed; a stale or future one is expired or early.
      return err.reason === "missing" ? "invalid_token" : "credential_expired";
    }
    return "invalid_token";
  }
  return "invalid_signature";
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
    return { ok: false, error: mapVerifyError(err) };
  }

  // Section 4.4.1: one audience, as a string or a one-element array.
  if (Array.isArray(payload.aud) && payload.aud.length !== 1) {
    return { ok: false, error: "invalid_audience" };
  }
  const jti = typeof payload.jti === "string" && payload.jti ? payload.jti : null;
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  const sub = typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  if (!jti || exp === null || !sub || jti.length > 256 || sub.length > 256) {
    return { ok: false, error: "invalid_token" };
  }
  // Consumed as soon as the signature holds, so a replay is always flagged.
  if (!(await recordJti(jti, iss, "id-jag", exp))) {
    return { ok: false, error: "replay_detected" };
  }

  const authTime =
    typeof payload.auth_time === "number" && Number.isFinite(payload.auth_time)
      ? payload.auth_time
      : null;
  if (authTime === null) return { ok: false, error: "auth_time_missing" };
  const authAge = Math.floor(Date.now() / 1000) - authTime;
  if (authAge < -CLOCK_TOLERANCE_SECS) return { ok: false, error: "invalid_token" };
  if (authAge > maxAuthAgeSeconds()) {
    return { ok: false, error: "auth_time_too_old", authAge };
  }

  // Section 4.4.1: the client_id claim identifies the client asking.
  if (typeof payload.client_id !== "string" || payload.client_id !== clientId) {
    return { ok: false, error: "client_mismatch" };
  }

  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email || payload.email_verified !== true) {
    return { ok: false, error: "missing_verified_email" };
  }

  return { ok: true, iss, sub, clientId, email, authTime };
}

export type OrgIdJagLink =
  | {
      status: "linked";
      registration: RegistrationRow;
      teamId: string | null;
      token: AccessToken;
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
        | "too_many_pending";
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
 * account: a person who is not a member is refused. The first use answers
 * interaction_required with a claim ceremony; once the member confirmed it,
 * later assertions for the same identity get an access token at once.
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
    p_claim_token_hash: hashClaimToken(claimToken),
    p_attempt_token_hash: secrets.attemptTokenHash,
    p_user_code_hash: secrets.userCodeHash,
    p_lifetime_seconds: UNCLAIMED_LIFETIME_SECONDS,
    p_attempt_seconds: USER_CODE_TTL_SECONDS,
    p_max_attempts: MAX_CLAIM_ATTEMPTS,
    p_max_pending: serverEnv().AGENT_MAX_PENDING_PER_LOGIN_HINT,
  });
  if (error) throw error;
  const result = data as {
    status: string;
    registration_id?: string;
    team_id?: string | null;
    created?: boolean;
    attempt?: number;
    attempt_expires_at?: string;
  };

  switch (result.status) {
    case "linked": {
      const registration = await readRegistration(result.registration_id!);
      const assertion = await signAssertion({
        registrationId: registration.id,
        stage: "claimed",
        expiresAt: new Date(Date.now() + CLAIMED_ASSERTION_TTL_SECONDS * 1000),
        email: await accountEmail(registration.user_id!),
      });
      // The same exchange as the jwt-bearer grant with our own assertion,
      // so the registration is read again and the token capped the same way.
      const token = await exchangeAssertion(assertion);
      return { status: "linked", registration, teamId: result.team_id ?? null, token };
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
      return { status: result.status };
    default:
      throw new Error(`Unexpected link_team_idjag_identity status: ${result.status}`);
  }
}
