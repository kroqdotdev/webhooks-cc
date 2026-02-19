/**
 * @fileoverview API authentication helpers for CLI-facing API routes.
 *
 * Validates API keys by calling the Convex /validate-api-key HTTP action,
 * and provides a helper to call /cli/* Convex HTTP actions with the shared secret.
 */
import { serverEnv } from "./env";

export type UserPlan = "free" | "pro";

export interface ApiKeyValidation {
  userId: string;
  plan?: UserPlan;
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
  const result = await validateApiKeyWithPlan(apiKey);
  return result?.userId ?? null;
}

/** Validate API key and return userId plus plan when available. */
export async function validateApiKeyWithPlan(apiKey: string): Promise<ApiKeyValidation | null> {
  let siteUrl: string;
  let secret: string;
  try {
    siteUrl = getConvexSiteUrl();
    secret = getSharedSecret();
  } catch {
    console.error("Missing CONVEX_SITE_URL or CAPTURE_SHARED_SECRET");
    return null;
  }

  const resp = await fetch(`${siteUrl}/validate-api-key`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ apiKey }),
  });

  if (!resp.ok) return null;

  const data: unknown = await resp.json();
  if (typeof data !== "object" || data === null) return null;
  const parsed = data as Record<string, unknown>;
  const userId = parsed.userId;
  if (typeof userId !== "string") return null;
  const plan = parsed.plan;
  const validPlan: UserPlan | undefined = plan === "free" || plan === "pro" ? plan : undefined;
  return { userId, plan: validPlan };
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
 * Authenticate a request using Bearer token API key.
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
      response: new Response(JSON.stringify({ error: "Invalid API key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  return { success: true, userId };
}
