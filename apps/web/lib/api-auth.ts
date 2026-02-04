/**
 * @fileoverview API authentication helpers for CLI-facing API routes.
 *
 * Validates API keys by calling the Convex /validate-api-key HTTP action,
 * and provides a helper to call /cli/* Convex HTTP actions with the shared secret.
 */

/** Extract Bearer token from Authorization header */
export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

function getConvexSiteUrl(): string {
  const url = process.env.CONVEX_SITE_URL;
  if (!url) throw new Error("CONVEX_SITE_URL is not configured");
  return url;
}

function getSharedSecret(): string {
  const secret = process.env.CAPTURE_SHARED_SECRET;
  if (!secret) throw new Error("CAPTURE_SHARED_SECRET is not configured");
  return secret;
}

/** Validate an API key via Convex HTTP action. Returns userId or null. */
export async function validateApiKey(apiKey: string): Promise<string | null> {
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
  const userId = (data as Record<string, unknown>).userId;
  return typeof userId === "string" ? userId : null;
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
