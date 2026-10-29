import { createHash } from "node:crypto";
import { customAlphabet } from "nanoid";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  MAX_CONNECTED_AGENTS,
  OAUTH_REFRESH_GRACE_SECONDS,
  OAUTH_REFRESH_TTL_SECONDS,
  POST_CLAIM_SCOPES,
} from "@/lib/agent/constants";
import { mintAccessToken, revokeAgentToken, type RegistrationRow } from "@/lib/agent/registrations";
import { hashCode } from "./authorize";

/**
 * The authorization_code and refresh_token grants, and refresh token
 * revocation. A redeemed code becomes an agent registration of kind
 * 'oauth' (migration 00066); access tokens are minted for it like for any
 * agent registration, so they are whcc_ keys every route already accepts.
 */

const generateRefreshBody = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  48
);
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** S256: base64url of the verifier's SHA-256 (RFC 7636 4.2). */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export interface OAuthTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  refresh_token: string;
  registration: RegistrationRow;
}

export class OAuthGrantError extends Error {
  constructor(
    readonly code: "invalid_grant" | "invalid_request",
    readonly description: string
  ) {
    super(description);
    this.name = "OAuthGrantError";
  }
}

async function loadRegistration(id: string): Promise<RegistrationRow> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("agent_registrations").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

async function issueTokens(registrationId: string, refreshToken: string): Promise<OAuthTokens> {
  const registration = await loadRegistration(registrationId);
  const issuedAtMs = Date.now();
  const token = await mintAccessToken(registration, {
    userId: registration.user_id,
    scopes: POST_CLAIM_SCOPES,
    issuedAtMs,
    expiresAtMs: issuedAtMs + ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
  // A disconnect, a replayed code or a replayed refresh token may have
  // revoked the grant between the grant check and the insert above; the
  // bearer check never reads the registration, so take the token back.
  if ((await loadRegistration(registrationId)).revoked_at) {
    await revokeAgentToken(token.accessToken);
    throw new OAuthGrantError("invalid_grant", "The connection was ended. Connect again.");
  }
  return {
    access_token: token.accessToken,
    token_type: "Bearer",
    expires_in: token.expiresIn,
    scope: token.scope,
    refresh_token: refreshToken,
    registration,
  };
}

function refreshExpiry(): string {
  return new Date(Date.now() + OAUTH_REFRESH_TTL_SECONDS * 1000).toISOString();
}

function newRefreshToken(): string {
  return `whrt_${generateRefreshBody()}`;
}

/** The authorization_code grant. */
export async function redeemAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<OAuthTokens> {
  if (!CODE_VERIFIER.test(input.codeVerifier)) {
    throw new OAuthGrantError("invalid_request", "code_verifier must be 43 to 128 characters.");
  }
  const refreshToken = newRefreshToken();
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("redeem_oauth_code", {
    p_code_hash: hashCode(input.code),
    p_client_id: input.clientId,
    p_redirect_uri: input.redirectUri,
    p_code_challenge: s256(input.codeVerifier),
    p_refresh_hash: hashRefreshToken(refreshToken),
    p_expires_at: refreshExpiry(),
    p_max_agents: MAX_CONNECTED_AGENTS,
  });
  if (error) throw error;
  const result = (data ?? {}) as { status?: string; registration_id?: string };
  switch (result.status) {
    case "ok":
      return issueTokens(result.registration_id!, refreshToken);
    case "too_many_agents":
      throw new OAuthGrantError(
        "invalid_grant",
        `The account already has ${MAX_CONNECTED_AGENTS} connected agents. Disconnect one under Account, Connected agents, then connect again.`
      );
    case "expired":
      throw new OAuthGrantError("invalid_grant", "The authorization code expired.");
    case "mismatch":
      throw new OAuthGrantError(
        "invalid_grant",
        "The code was issued to another client or redirect URI, or the code_verifier does not match."
      );
    default:
      throw new OAuthGrantError("invalid_grant", "The authorization code is unknown or used.");
  }
}

/** The refresh_token grant: rotates the refresh token. */
export async function refreshTokens(input: {
  refreshToken: string;
  clientId: string;
}): Promise<OAuthTokens> {
  const refreshToken = newRefreshToken();
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("rotate_oauth_refresh", {
    p_refresh_hash: hashRefreshToken(input.refreshToken),
    p_client_id: input.clientId,
    p_new_hash: hashRefreshToken(refreshToken),
    p_expires_at: refreshExpiry(),
    p_grace_seconds: OAUTH_REFRESH_GRACE_SECONDS,
  });
  if (error) throw error;
  const result = (data ?? {}) as { status?: string; registration_id?: string };
  switch (result.status) {
    case "ok":
      return issueTokens(result.registration_id!, refreshToken);
    case "replayed":
      throw new OAuthGrantError(
        "invalid_grant",
        "This refresh token was used before, so the connection was ended. Connect again."
      );
    default:
      throw new OAuthGrantError(
        "invalid_grant",
        "The refresh token is unknown, expired or revoked. Connect again."
      );
  }
}

/** RFC 7009 for a refresh token: ends the grant and its access tokens. */
export async function revokeRefreshToken(token: string): Promise<string | null> {
  if (!token.startsWith("whrt_") || token.length > 128) return null;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("revoke_oauth_refresh", {
    p_refresh_hash: hashRefreshToken(token),
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}
