/**
 * @fileoverview API authentication helpers for bearer-authenticated API routes.
 *
 * Validates API keys and Supabase session tokens against Supabase.
 */
import { publicEnv } from "./env";
import { createAdminClient } from "./supabase/admin";
import { validateApiKeyWithMetadata } from "./supabase/api-keys";

export type UserPlan = "free" | "pro";

export interface ApiKeyValidation {
  /**
   * Owning user, or `null` for unowned agent-issued keys (auth.md anonymous
   * flow) that have not yet been claimed. Session-token validation always
   * yields a real (non-null) userId.
   */
  userId: string | null;
  plan?: UserPlan;
  /** True when the bearer is an agent-issued key (auth.md flows). */
  isAgentIssued?: boolean;
}

/**
 * Validation result for a Supabase session token. Unlike {@link ApiKeyValidation},
 * `userId` is always a real (non-null) user — session tokens never represent an
 * unowned agent-issued key.
 */
export interface SessionValidation {
  userId: string;
  plan?: UserPlan;
}

async function validateSupabaseSessionWithPlan(
  accessToken: string
): Promise<SessionValidation | null> {
  const admin = createAdminClient();
  const {
    data: { user },
    error: authError,
  } = await admin.auth.getUser(accessToken);

  if (authError || !user) {
    return null;
  }

  const { data: userRow, error: userError } = await admin
    .from("users")
    .select("plan")
    .eq("id", user.id)
    .maybeSingle<{ plan: UserPlan }>();

  if (userError) {
    throw userError;
  }

  return {
    userId: user.id,
    plan: userRow?.plan,
  };
}

/**
 * Build the RFC 9728 `WWW-Authenticate` challenge value pointing agents at the
 * OAuth protected-resource metadata document. This is the ONLY place this header
 * is constructed — surface routes must not duplicate it; they rely on
 * `authenticateRequest` / `authenticateSessionRequest` to emit it on 401s.
 */
export function wwwAuthenticateHeader(): string {
  return `Bearer resource_metadata="${publicEnv().NEXT_PUBLIC_APP_URL}/.well-known/oauth-protected-resource"`;
}

/** Extract Bearer token from Authorization header */
export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

/** Validate an API key. Returns userId or null. */
export async function validateApiKey(apiKey: string): Promise<string | null> {
  const result = await validateBearerTokenWithPlan(apiKey);
  return result?.userId ?? null;
}

/** Validate a bearer token (API key or Supabase session) and return userId plus plan. */
export async function validateBearerTokenWithPlan(token: string): Promise<ApiKeyValidation | null> {
  try {
    if (token.startsWith("whcc_")) {
      return await validateApiKeyWithMetadata(token);
    }

    return await validateSupabaseSessionWithPlan(token);
  } catch {
    console.error("Failed to validate bearer token against Supabase");
    return null;
  }
}

/** Backwards-compatible alias for API-key consumers. */
export async function validateApiKeyWithPlan(apiKey: string): Promise<ApiKeyValidation | null> {
  return validateBearerTokenWithPlan(apiKey);
}

/**
 * Authenticate a request using a Bearer API key or Supabase session token.
 * Returns { success: true, userId } on success, or { success: false, response } on failure.
 *
 * NOTE: `userId` may be `null` when the bearer is an unowned, agent-issued key
 * (auth.md anonymous flow) that has not yet been claimed. The key is a VALID
 * bearer, but it is not bound to a user. Handlers that require a real user
 * (e.g. anything writing rows keyed on `user_id`, per-user rate limiting, or
 * account-scoped reads) MUST treat a null `userId` as forbidden and reject the
 * request themselves. Those routes are intentionally NOT modified here.
 */
export type AuthResult =
  | { success: true; userId: string | null; isAgentIssued?: boolean }
  | { success: false; response: Response };

/**
 * Result of session-only authentication. `userId` is always a real (non-null)
 * user because session-token validation never yields an unowned key.
 */
export type SessionAuthResult =
  | { success: true; userId: string }
  | { success: false; response: Response };

export async function authenticateRequest(request: Request): Promise<AuthResult> {
  const token = extractBearerToken(request);
  if (!token) {
    return {
      success: false,
      response: new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": wwwAuthenticateHeader(),
        },
      }),
    };
  }

  const result = await validateBearerTokenWithPlan(token);
  if (!result) {
    return {
      success: false,
      response: new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": wwwAuthenticateHeader(),
        },
      }),
    };
  }

  return { success: true, userId: result.userId, isAgentIssued: result.isAgentIssued };
}

/**
 * Like {@link authenticateRequest}, but rejects unowned, agent-issued keys
 * (auth.md anonymous flow) that have not been claimed: a valid bearer with a
 * `null` userId yields a 403. On success `userId` is guaranteed non-null.
 *
 * Use this for routes that write rows keyed on `user_id`, perform per-user rate
 * limiting, or do account-scoped reads — anything that needs a real user. This
 * is where the api-auth boundary enforces the "claim before you write" rule
 * documented on {@link AuthResult}.
 */
export async function authenticateRequestRequireUser(
  request: Request
): Promise<SessionAuthResult> {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth;

  if (auth.userId === null) {
    return {
      success: false,
      response: new Response(
        JSON.stringify({
          error:
            "This operation requires a claimed account. Complete the claim ceremony to bind your agent key to a user.",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      ),
    };
  }

  return { success: true, userId: auth.userId };
}

/**
 * Authenticate a request using only a Supabase session token.
 * Rejects API keys — use this for sensitive routes (account deletion, billing mutations)
 * where long-lived API keys should not have access.
 */
export async function authenticateSessionRequest(
  request: Request
): Promise<SessionAuthResult> {
  const token = extractBearerToken(request);
  if (!token) {
    return {
      success: false,
      response: new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": wwwAuthenticateHeader(),
        },
      }),
    };
  }

  if (token.startsWith("whcc_")) {
    return {
      success: false,
      response: new Response(
        JSON.stringify({
          error: "API keys are not allowed for this operation. Use a session token.",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      ),
    };
  }

  const result = await validateSupabaseSessionWithPlan(token);
  if (!result) {
    return {
      success: false,
      response: new Response(JSON.stringify({ error: "Invalid session token" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": wwwAuthenticateHeader(),
        },
      }),
    };
  }

  return { success: true, userId: result.userId };
}
