/**
 * @fileoverview API authentication helpers for CLI-facing API routes.
 *
 * Validates API keys by calling the Convex /validate-api-key HTTP action,
 * and provides a helper to call /cli/* Convex HTTP actions with the shared secret.
 */

const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL;
const CAPTURE_SHARED_SECRET = process.env.CAPTURE_SHARED_SECRET;

/** Extract Bearer token from Authorization header */
export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

/** Validate an API key via Convex HTTP action. Returns userId or null. */
export async function validateApiKey(apiKey: string): Promise<string | null> {
  if (!CONVEX_SITE_URL || !CAPTURE_SHARED_SECRET) {
    console.error("Missing CONVEX_SITE_URL or CAPTURE_SHARED_SECRET");
    return null;
  }

  const resp = await fetch(`${CONVEX_SITE_URL}/validate-api-key`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CAPTURE_SHARED_SECRET}`,
    },
    body: JSON.stringify({ apiKey }),
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  return data.userId ?? null;
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
  if (!CONVEX_SITE_URL || !CAPTURE_SHARED_SECRET) {
    return new Response(JSON.stringify({ error: "Server misconfigured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(`${CONVEX_SITE_URL}${path}`);
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url.searchParams.set(key, value);
    }
  }

  const resp = await fetch(url.toString(), {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CAPTURE_SHARED_SECRET}`,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
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
 * Returns userId on success, or an error Response.
 */
export async function authenticateRequest(
  request: Request
): Promise<{ userId: string } | Response> {
  const token = extractBearerToken(request);
  if (!token) {
    return new Response(JSON.stringify({ error: "Missing authorization header" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const userId = await validateApiKey(token);
  if (!userId) {
    return new Response(JSON.stringify({ error: "Invalid API key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return { userId };
}
