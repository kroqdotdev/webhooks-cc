import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();

// Auth HTTP routes for OAuth callbacks
auth.addHttpRoutes(http);

// Allowed HTTP methods for webhook capture
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

// Valid slug format: alphanumeric (mixed case) with hyphens/underscores, 1-50 chars
// nanoid uses alphabet A-Za-z0-9_- by default, so slugs can start/end with any of these
const SLUG_REGEX = /^[a-zA-Z0-9_-]{1,50}$/;

// Maximum body size allowed (1MB)
const MAX_BODY_SIZE = 1024 * 1024;
// Maximum headers count
const MAX_HEADERS = 100;
// Maximum query params count
const MAX_QUERY_PARAMS = 100;
// Maximum path length
const MAX_PATH_LENGTH = 2048;
// Maximum IP address length (IPv6 = 45 chars max)
const MAX_IP_LENGTH = 45;

/**
 * Validates that an object is a Record<string, string>
 */
function isStringRecord(obj: unknown): obj is Record<string, string> {
  if (typeof obj !== "object" || obj === null) return false;
  return Object.values(obj).every((v) => typeof v === "string");
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Uses HMAC-based comparison which runs in constant time.
 */
async function secureCompare(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const algorithm = { name: "HMAC", hash: "SHA-256" };

  try {
    const keyA = await crypto.subtle.importKey("raw", encoder.encode(a), algorithm, false, [
      "sign",
    ]);
    const sigA = await crypto.subtle.sign("HMAC", keyA, encoder.encode("compare"));

    const keyB = await crypto.subtle.importKey("raw", encoder.encode(b), algorithm, false, [
      "sign",
    ]);
    const sigB = await crypto.subtle.sign("HMAC", keyB, encoder.encode("compare"));

    const arrA = new Uint8Array(sigA);
    const arrB = new Uint8Array(sigB);

    if (arrA.length !== arrB.length) return false;

    let result = 0;
    for (let i = 0; i < arrA.length; i++) {
      result |= arrA[i] ^ arrB[i];
    }
    return result === 0;
  } catch {
    return false;
  }
}

// HTTP endpoint for Go receiver to fetch quota information for rate limiting.
// Returns remaining quota for a given slug, enabling the receiver to enforce
// limits locally and avoid OCC conflicts from concurrent user doc reads.
// Usage: GET /quota?slug=xxx
http.route({
  path: "/quota",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    // Verify shared secret from Go receiver
    const authHeader = request.headers.get("Authorization");
    const expectedSecret = process.env.CAPTURE_SHARED_SECRET;

    if (!expectedSecret) {
      console.error("CAPTURE_SHARED_SECRET is not configured - denying request");
      return new Response(JSON.stringify({ error: "server_misconfiguration" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const providedSecret = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const isValid = await secureCompare(providedSecret, expectedSecret);
    if (!isValid) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Extract slug from query parameter
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug");

    if (!slug || !SLUG_REGEX.test(slug)) {
      return new Response(JSON.stringify({ error: "invalid_slug" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Look up endpoint and user quota
    const result = await ctx.runQuery(internal.requests.getQuota, { slug });

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// HTTP endpoint for Go receiver to get endpoint info for caching.
// Returns endpoint details including mock response configuration.
// Usage: GET /endpoint-info?slug=xxx
http.route({
  path: "/endpoint-info",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    // Verify shared secret from Go receiver
    const authHeader = request.headers.get("Authorization");
    const expectedSecret = process.env.CAPTURE_SHARED_SECRET;

    if (!expectedSecret) {
      console.error("CAPTURE_SHARED_SECRET is not configured - denying request");
      return new Response(JSON.stringify({ error: "server_misconfiguration" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const providedSecret = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const isValid = await secureCompare(providedSecret, expectedSecret);
    if (!isValid) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Extract slug from query parameter
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug");

    if (!slug || !SLUG_REGEX.test(slug)) {
      return new Response(JSON.stringify({ error: "invalid_slug" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Get endpoint info
    const result = await ctx.runQuery(internal.requests.getEndpointInfo, { slug });

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// HTTP endpoint for Go receiver to capture webhook requests in batches.
// Accepts an array of requests for a single slug.
// Usage: POST /capture-batch
http.route({
  path: "/capture-batch",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Verify shared secret from Go receiver
    const authHeader = request.headers.get("Authorization");
    const expectedSecret = process.env.CAPTURE_SHARED_SECRET;

    if (!expectedSecret) {
      console.error("CAPTURE_SHARED_SECRET is not configured - denying request");
      return new Response(JSON.stringify({ error: "server_misconfiguration" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const providedSecret = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const isValid = await secureCompare(providedSecret, expectedSecret);
    if (!isValid) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate slug format
    if (typeof body.slug !== "string" || !SLUG_REGEX.test(body.slug)) {
      return new Response(JSON.stringify({ error: "invalid_slug" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate requests array
    if (!Array.isArray(body.requests) || body.requests.length === 0) {
      return new Response(JSON.stringify({ error: "invalid_requests" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Limit batch size to prevent timeout
    if (body.requests.length > 100) {
      return new Response(JSON.stringify({ error: "batch_too_large" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await ctx.runMutation(internal.requests.captureBatch, body);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// HTTP endpoint for Go receiver to capture webhook requests
// SECURITY: This endpoint REQUIRES a shared secret to prevent unauthorized access.
// The Go receiver must include the secret in the Authorization header.
// If CAPTURE_SHARED_SECRET is not configured, all requests are denied (fail closed).
http.route({
  path: "/capture",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Verify shared secret from Go receiver - REQUIRED, not optional
    const authHeader = request.headers.get("Authorization");
    const expectedSecret = process.env.CAPTURE_SHARED_SECRET;

    // Fail closed: if secret is not configured, deny all requests
    if (!expectedSecret) {
      console.error("CAPTURE_SHARED_SECRET is not configured - denying request");
      return new Response(JSON.stringify({ error: "server_misconfiguration" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Verify the authorization header matches the expected secret (constant-time comparison)
    const providedSecret = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const isValid = await secureCompare(providedSecret, expectedSecret);
    if (!isValid) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate HTTP method
    if (typeof body.method !== "string" || !ALLOWED_METHODS.has(body.method.toUpperCase())) {
      return new Response(JSON.stringify({ error: "invalid_method" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate slug format to prevent injection
    if (typeof body.slug !== "string" || !SLUG_REGEX.test(body.slug)) {
      return new Response(JSON.stringify({ error: "invalid_slug" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate path
    if (typeof body.path !== "string" || body.path.length > MAX_PATH_LENGTH) {
      return new Response(JSON.stringify({ error: "invalid_path" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate IP address
    if (typeof body.ip !== "string" || body.ip.length > MAX_IP_LENGTH) {
      return new Response(JSON.stringify({ error: "invalid_ip" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate body size
    if (typeof body.body === "string" && body.body.length > MAX_BODY_SIZE) {
      return new Response(JSON.stringify({ error: "body_too_large" }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate headers count, structure, and values are all strings
    if (!isStringRecord(body.headers) || Object.keys(body.headers).length > MAX_HEADERS) {
      return new Response(JSON.stringify({ error: "invalid_headers" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate query params count, structure, and values are all strings
    if (
      !isStringRecord(body.queryParams) ||
      Object.keys(body.queryParams).length > MAX_QUERY_PARAMS
    ) {
      return new Response(JSON.stringify({ error: "invalid_query_params" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await ctx.runMutation(internal.requests.capture, body);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
