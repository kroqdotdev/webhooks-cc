import { createHash } from "node:crypto";
import { customAlphabet } from "nanoid";
import { publicEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { OAUTH_CODE_TTL_SECONDS, POST_CLAIM_SCOPES } from "@/lib/agent/constants";
import {
  ClientMetadataError,
  redirectUriMatches,
  resolveClient,
  touchRegisteredClient,
  type OAuthClient,
} from "./clients";

/**
 * The authorization endpoint's rules (OAuth 2.1 authorization code with
 * PKCE, as the MCP authorization spec asks). The consent page at
 * /oauth/authorize asks /api/oauth2/authorize to check a request before
 * showing it, and again when the human decides.
 *
 * A refused request is shown to the human, never redirected: a redirect URI
 * that matches a dynamically registered client proves nothing (anyone can
 * register one), so the page navigates only after the human clicks Connect
 * or Decline. Every redirect carries `iss` (RFC 9207), so a client talking to
 * several authorization servers can tell whose answer it got.
 */

export const OAUTH_SCOPE = POST_CLAIM_SCOPES.join(" ");
const MAX_STATE_LENGTH = 2048;
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const generateCodeBody = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  43
);

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  /** What is granted: always the account scopes (they are not enforced per route). */
  scope: string;
  resource: string | null;
}

export type AuthorizationCheck =
  | { ok: true; request: AuthorizationRequest; client: OAuthClient }
  /** A refusal: shown to the human, never redirected (the page navigates only on a decision). */
  | { ok: false; error: string; description: string };

function issuer(): string {
  return publicEnv().NEXT_PUBLIC_APP_URL;
}

/** The resources a token from this server is good for. */
export function acceptedResources(): string[] {
  const app = issuer();
  return [`${app}/mcp`, `${app}/api/`];
}

function normalizeResource(value: string): string {
  // `${app}/mcp/` and `${app}/api` name the same resources.
  const app = issuer();
  if (value === `${app}/mcp/`) return `${app}/mcp`;
  if (value === `${app}/api`) return `${app}/api/`;
  return value;
}

/** The client's redirect URI with the answer's parameters added. */
export function redirectWith(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  url.searchParams.set("iss", issuer());
  return url.toString();
}

export function errorRedirect(
  request: { redirectUri: string; state: string | null },
  error: string,
  description: string
): string {
  return redirectWith(request.redirectUri, {
    error,
    error_description: description,
    state: request.state,
  });
}

function param(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  // A repeated parameter is an error (RFC 6749 3.1); treat it as missing.
  return values.length === 1 ? values[0] : null;
}

/** Checks an authorization request's parameters. */
export async function checkAuthorizationRequest(
  params: URLSearchParams
): Promise<AuthorizationCheck> {
  const clientId = param(params, "client_id");
  if (!clientId) {
    return { ok: false, error: "invalid_request", description: "The request names no client." };
  }
  let client: OAuthClient | null;
  try {
    client = await resolveClient(clientId);
  } catch (error) {
    if (error instanceof ClientMetadataError) {
      return { ok: false, error: "invalid_client", description: error.message };
    }
    throw error;
  }
  if (!client) {
    return {
      ok: false,
      error: "invalid_client",
      description: "This app is not registered with webhooks.cc. Connect again from the app.",
    };
  }

  const redirectUri = param(params, "redirect_uri");
  if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
    return {
      ok: false,
      error: "invalid_request",
      description: "The app asked to return to an address it did not register.",
    };
  }

  const state = param(params, "state");
  const back = { redirectUri, state: state && state.length <= MAX_STATE_LENGTH ? state : null };
  if (state && state.length > MAX_STATE_LENGTH) {
    return { ok: false, error: "invalid_request", description: "state is too long." };
  }
  if (param(params, "response_type") !== "code") {
    return {
      ok: false,
      error: "unsupported_response_type",
      description: "Use response_type=code.",
    };
  }
  const codeChallenge = param(params, "code_challenge");
  if (param(params, "code_challenge_method") !== "S256" || !codeChallenge) {
    return {
      ok: false,
      error: "invalid_request",
      description: "PKCE with code_challenge_method=S256 is required.",
    };
  }
  if (!CODE_CHALLENGE.test(codeChallenge)) {
    return {
      ok: false,
      error: "invalid_request",
      description: "code_challenge must be an S256 challenge.",
    };
  }
  const rawResource = param(params, "resource");
  const resource = rawResource ? normalizeResource(rawResource) : null;
  if (resource && !acceptedResources().includes(resource)) {
    return {
      ok: false,
      error: "invalid_target",
      description: `resource must be one of ${acceptedResources().join(", ")}.`,
    };
  }

  return {
    ok: true,
    client,
    request: {
      clientId,
      redirectUri,
      state: back.state,
      codeChallenge,
      // Unknown scopes (openid, offline_access, ...) are ignored; what a
      // token reaches is the account API either way.
      scope: OAUTH_SCOPE,
      resource,
    },
  };
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Issues a single-use code for an approved request; returns where to send the human. */
export async function approveAuthorization(
  request: AuthorizationRequest,
  client: OAuthClient,
  userId: string
): Promise<string> {
  const code = `whac_${generateCodeBody()}`;
  const admin = createAdminClient();
  const { error } = await admin.from("oauth_authorization_codes").insert({
    code_hash: hashCode(code),
    client_id: request.clientId,
    client_name: (client.name ?? client.verifiedHost)?.slice(0, 100) ?? null,
    user_id: userId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    scope: request.scope,
    resource: request.resource,
    expires_at: new Date(Date.now() + OAUTH_CODE_TTL_SECONDS * 1000).toISOString(),
  });
  if (error) throw error;
  await touchRegisteredClient(request.clientId);
  return redirectWith(request.redirectUri, { code, state: request.state });
}

/** Where to send the human after they declined. */
export function denyAuthorization(request: AuthorizationRequest): string {
  return errorRedirect(request, "access_denied", "The human declined.");
}
