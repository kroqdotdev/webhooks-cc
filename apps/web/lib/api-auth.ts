/**
 * @fileoverview API authentication helpers for bearer-authenticated API routes.
 *
 * Validates API keys and Supabase session tokens against Supabase and keeps a helper for the remaining
 * Convex-backed /cli/* routes during the migration transition.
 */
import { serverEnv } from "./env";
import { createAdminClient } from "./supabase/admin";
import { validateApiKeyWithMetadata } from "./supabase/api-keys";

export type UserPlan = "free" | "pro";

export interface ApiKeyValidation {
  userId: string;
  plan?: UserPlan;
}

async function validateSupabaseSessionWithPlan(
  accessToken: string
): Promise<ApiKeyValidation | null> {
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

/** Extract Bearer token from Authorization header */
export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

function getConvexSiteUrl(): string {
  return serverEnv().CONVEX_SITE_URL;
}

function getSharedSecret(): string {
  return serverEnv().CAPTURE_SHARED_SECRET;
}

/** Validate an API key via Convex HTTP action. Returns userId or null. */
export async function validateApiKey(apiKey: string): Promise<string | null> {
  const result = await validateBearerTokenWithPlan(apiKey);
  return result?.userId ?? null;
}

/** Validate a bearer token (API key or Supabase session) and return userId plus plan. */
export async function validateBearerTokenWithPlan(
  token: string
): Promise<ApiKeyValidation | null> {
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

/** Call a /cli/* Convex HTTP action with shared secret authentication. */
export async function convexCliRequest(
  path: string,
  options: {
    method?: string;
    params?: Record<string, string>;
    body?: unknown;
  } = {}
): Promise<Response> {
  let siteUrl: string;
  let secret: string;
  try {
    siteUrl = getConvexSiteUrl();
    secret = getSharedSecret();
  } catch {
    return new Response(JSON.stringify({ error: "Server misconfigured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const method = options.method ?? "GET";
  const url = new URL(`${siteUrl}${path}`);
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url.searchParams.set(key, value);
    }
  }

  const hasBody = options.body && method !== "GET";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
  };
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }

  const resp = await fetch(url.toString(), {
    method,
    headers,
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
  });

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    console.error(`Non-JSON response from Convex ${path}: status ${resp.status}`);
    return new Response(JSON.stringify({ error: "Upstream error" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(data), {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build the webhook URL for a given slug using server-side env var. Returns undefined if not configured. */
function webhookUrl(slug: string): string | undefined {
  const base = process.env.WEBHOOK_BASE_URL ?? process.env.NEXT_PUBLIC_WEBHOOK_URL;
  if (!base) return undefined;
  return `${base}/w/${slug}`;
}

/** Transform a Convex endpoint document into the SDK Endpoint shape. */
export function formatEndpoint(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    id: doc._id ?? doc.id,
    slug: doc.slug,
    name: doc.name,
    url: typeof doc.slug === "string" ? webhookUrl(doc.slug) : undefined,
    isEphemeral: doc.isEphemeral === true,
    expiresAt: typeof doc.expiresAt === "number" ? doc.expiresAt : undefined,
    createdAt: doc.createdAt ?? doc._creationTime,
  };
}

/** Transform a Convex request document into the SDK Request shape. */
export function formatRequest(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    id: doc._id ?? doc.id,
    endpointId: doc.endpointId,
    method: doc.method,
    path: doc.path,
    headers: doc.headers,
    body: doc.body,
    queryParams: doc.queryParams,
    contentType: doc.contentType,
    ip: doc.ip,
    size: doc.size,
    receivedAt: doc.receivedAt,
  };
}

/**
 * Authenticate a request using a Bearer API key or Supabase session token.
 * Returns { success: true, userId } on success, or { success: false, response } on failure.
 */
export type AuthResult = { success: true; userId: string } | { success: false; response: Response };

export async function authenticateRequest(request: Request): Promise<AuthResult> {
  const token = extractBearerToken(request);
  if (!token) {
    return {
      success: false,
      response: new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  const userId = await validateApiKey(token);
  if (!userId) {
    return {
      success: false,
      response: new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  return { success: true, userId };
}

/**
 * Authenticate a request using only a Supabase session token.
 * Rejects API keys — use this for sensitive routes (account deletion, billing mutations)
 * where long-lived API keys should not have access.
 */
export async function authenticateSessionRequest(request: Request): Promise<AuthResult> {
  const token = extractBearerToken(request);
  if (!token) {
    return {
      success: false,
      response: new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  if (token.startsWith("whcc_")) {
    return {
      success: false,
      response: new Response(
        JSON.stringify({ error: "API keys are not allowed for this operation. Use a session token." }),
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
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  return { success: true, userId: result.userId };
}
