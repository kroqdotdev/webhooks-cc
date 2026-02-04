import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auth } from "./auth";

const http = httpRouter();

// Auth HTTP routes for OAuth callbacks
auth.addHttpRoutes(http);

// Webhook signature tolerance (5 minutes)
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * Verify Polar webhook signature using standardwebhooks format.
 * Uses Web Crypto API which is available in Convex runtime.
 *
 * Headers used:
 * - webhook-id: Unique message ID
 * - webhook-timestamp: Unix timestamp in seconds
 * - webhook-signature: "v1,{base64-hmac-sha256}"
 *
 * Signature is computed as HMAC-SHA256 of "${msgId}.${timestamp}.${body}"
 */
async function verifyWebhookSignature(
  body: string,
  headers: Record<string, string>,
  secret: string
): Promise<{ verified: boolean; error?: string }> {
  const msgId = headers["webhook-id"];
  const msgTimestamp = headers["webhook-timestamp"];
  const msgSignature = headers["webhook-signature"];

  if (!msgId || !msgTimestamp || !msgSignature) {
    return { verified: false, error: "Missing required webhook headers" };
  }

  // Verify timestamp is within tolerance
  const timestamp = parseInt(msgTimestamp, 10);
  if (isNaN(timestamp)) {
    return { verified: false, error: "Invalid timestamp header" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > WEBHOOK_TOLERANCE_SECONDS) {
    return { verified: false, error: "Message timestamp too old" };
  }
  if (timestamp > now + WEBHOOK_TOLERANCE_SECONDS) {
    return { verified: false, error: "Message timestamp too new" };
  }

  // Convert secret string to bytes (matching Polar SDK behavior)
  // The Polar SDK does: Buffer.from(secret, "utf-8") which just converts string to bytes
  const encoder = new TextEncoder();
  const secretBytes = encoder.encode(secret);

  // Import the key for HMAC-SHA256
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  // Compute the signature: HMAC-SHA256 of "${msgId}.${timestamp}.${body}"
  const toSign = encoder.encode(`${msgId}.${timestamp}.${body}`);
  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, toSign);

  // Convert to base64
  const computedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

  // Parse the provided signatures (format: "v1,{sig1} v1,{sig2} ...")
  const passedSignatures = msgSignature.split(" ");
  for (const versionedSig of passedSignatures) {
    const [version, signature] = versionedSig.split(",");
    if (version !== "v1") continue;

    // Constant-time comparison to prevent timing attacks
    const encoder2 = new TextEncoder();
    const sigA = encoder2.encode(signature);
    const sigB = encoder2.encode(computedSignature);

    if (sigA.length === sigB.length) {
      let result = 0;
      for (let i = 0; i < sigA.length; i++) {
        result |= sigA[i] ^ sigB[i];
      }
      if (result === 0) {
        return { verified: true };
      }
    }
  }

  return { verified: false, error: "No matching signature found" };
}

// Polar webhook endpoint for billing events
http.route({
  path: "/polar-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.text();
    const webhookSecret = process.env.POLAR_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error("[polar-webhook] POLAR_WEBHOOK_SECRET is not configured");
      return new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Convert Headers to Record<string, string>
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    // Verify webhook signature
    const verification = await verifyWebhookSignature(body, headers, webhookSecret);
    if (!verification.verified) {
      console.error("[polar-webhook] Signature verification failed:", verification.error);
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Parse the webhook payload
    let event;
    try {
      event = JSON.parse(body);
    } catch {
      console.error("[polar-webhook] Invalid JSON payload");
      return new Response(JSON.stringify({ error: "invalid_payload" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!event.type || !event.data) {
      console.error("[polar-webhook] Missing type or data in payload");
      return new Response(JSON.stringify({ error: "invalid_payload" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Process the webhook event
    try {
      await ctx.runMutation(internal.billing.handleWebhook, {
        event: event.type,
        data: event.data,
      });
    } catch (error) {
      console.error("[polar-webhook] Failed to process event:", error);
      // Return 200 to prevent Polar from retrying - we've logged the error
      // Retrying with the same data would just fail again
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

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

/**
 * Creates an HTTP error response for capture mutation results.
 * Returns null if the result is successful (no error).
 */
function createCaptureErrorResponse(result: {
  error?: string;
  retryAfter?: number;
  periodEnd?: number | null;
}): Response | null {
  if (result.error === "rate_limited" || result.error === "quota_exceeded") {
    return new Response(JSON.stringify(result), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        ...(result.retryAfter
          ? { "Retry-After": String(Math.ceil(result.retryAfter / 1000)) }
          : {}),
      },
    });
  }
  if (result.error === "not_found") {
    return new Response(JSON.stringify(result), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (result.error === "expired") {
    return new Response(JSON.stringify(result), {
      status: 410,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

// HTTP endpoint for Go receiver to fetch quota information for rate limiting.
// Returns remaining quota for a given slug, enabling the receiver to enforce
// limits locally and avoid OCC conflicts from concurrent user doc reads.
// Usage: GET /quota?slug=xxx
http.route({
  path: "/quota",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authError = await verifySharedSecret(request);
    if (authError) return authError;

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

// HTTP endpoint for Go receiver to check and start a free user's period if needed.
// Called when getQuota returns needsPeriodStart=true.
// Usage: POST /check-period with { userId: string }
http.route({
  path: "/check-period",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authError = await verifySharedSecret(request);
    if (authError) return authError;

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Basic validation - Convex's v.id() validator will verify the actual ID format
    if (typeof body.userId !== "string" || body.userId.length === 0) {
      return new Response(JSON.stringify({ error: "invalid_user_id" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let result;
    try {
      result = await ctx.runMutation(internal.requests.checkAndStartPeriod, {
        userId: body.userId,
      });
    } catch (error) {
      // Invalid ID format will throw from v.id() validator
      console.error("checkAndStartPeriod error:", error);
      return new Response(JSON.stringify({ error: "invalid_user_id" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const errorResponse = createCaptureErrorResponse(result);
    if (errorResponse) return errorResponse;

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
    const authError = await verifySharedSecret(request);
    if (authError) return authError;

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
    const authError = await verifySharedSecret(request);
    if (authError) return authError;

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

    // Validate each request in the batch (same validation as single /capture)
    for (const req of body.requests) {
      // Validate HTTP method
      if (typeof req.method !== "string" || !ALLOWED_METHODS.has(req.method.toUpperCase())) {
        return new Response(JSON.stringify({ error: "invalid_method" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Validate path
      if (typeof req.path !== "string" || req.path.length > MAX_PATH_LENGTH) {
        return new Response(JSON.stringify({ error: "invalid_path" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Validate IP address
      if (typeof req.ip !== "string" || req.ip.length > MAX_IP_LENGTH) {
        return new Response(JSON.stringify({ error: "invalid_ip" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Validate body size
      if (typeof req.body === "string" && req.body.length > MAX_BODY_SIZE) {
        return new Response(JSON.stringify({ error: "body_too_large" }), {
          status: 413,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Validate headers count, structure, and values are all strings
      if (!isStringRecord(req.headers) || Object.keys(req.headers).length > MAX_HEADERS) {
        return new Response(JSON.stringify({ error: "invalid_headers" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Validate query params count, structure, and values are all strings
      if (
        !isStringRecord(req.queryParams) ||
        Object.keys(req.queryParams).length > MAX_QUERY_PARAMS
      ) {
        return new Response(JSON.stringify({ error: "invalid_query_params" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Validate receivedAt timestamp (must be within last 60 seconds to prevent backdating)
      if (typeof req.receivedAt !== "number") {
        return new Response(JSON.stringify({ error: "invalid_timestamp" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const now = Date.now();
      const sixtySecondsAgo = now - 60000;
      if (req.receivedAt < sixtySecondsAgo || req.receivedAt > now + 5000) {
        return new Response(JSON.stringify({ error: "invalid_timestamp" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    const result = await ctx.runMutation(internal.requests.captureBatch, body);

    const errorResponse = createCaptureErrorResponse(result);
    if (errorResponse) return errorResponse;

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
    const authError = await verifySharedSecret(request);
    if (authError) return authError;

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

    const errorResponse = createCaptureErrorResponse(result);
    if (errorResponse) return errorResponse;

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// --- CLI API HTTP actions (shared-secret authenticated) ---

/** Helper to verify shared secret and return error response if invalid */
async function verifySharedSecret(request: Request): Promise<Response | null> {
  const authHeader = request.headers.get("Authorization");
  const expectedSecret = process.env.CAPTURE_SHARED_SECRET;

  if (!expectedSecret) {
    console.error("CAPTURE_SHARED_SECRET is not configured - denying request");
    return new Response(JSON.stringify({ error: "internal_error" }), {
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

  return null;
}

// Validate API key and return userId
http.route({
  path: "/validate-api-key",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authError = await verifySharedSecret(request);
    if (authError) return authError;

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.apiKey !== "string" || body.apiKey.length === 0) {
      return new Response(JSON.stringify({ error: "missing_api_key" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await ctx.runMutation(internal.apiKeys.validate, { key: body.apiKey });
    if (!result) {
      return new Response(JSON.stringify({ error: "invalid_api_key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ userId: result.userId }), {
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Create endpoint for user
http.route({
  path: "/cli/endpoints",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authError = await verifySharedSecret(request);
    if (authError) return authError;

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.userId !== "string" || body.userId.length === 0) {
      return new Response(JSON.stringify({ error: "missing_user_id" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const result = await ctx.runMutation(internal.endpoints.createForUser, {
        userId: body.userId,
        name: body.name,
      });
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("[cli/endpoints POST]", error);
      return new Response(JSON.stringify({ error: "Failed to create endpoint" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

// List endpoints for user
http.route({
  path: "/cli/endpoints",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authError = await verifySharedSecret(request);
    if (authError) return authError;

    const url = new URL(request.url);
    const userId = url.searchParams.get("userId");
    if (!userId) {
      return new Response(JSON.stringify({ error: "missing_user_id" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const endpoints = await ctx.runQuery(internal.endpoints.listByUser, {
        userId: userId as Id<"users">,
      });
      return new Response(JSON.stringify(endpoints), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("[cli/endpoints GET]", error);
      return new Response(JSON.stringify({ error: "Failed to list endpoints" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

// Delete endpoint for user
http.route({
  path: "/cli/endpoints",
  method: "DELETE",
  handler: httpAction(async (ctx, request) => {
    const authError = await verifySharedSecret(request);
    if (authError) return authError;

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.userId !== "string" || typeof body.slug !== "string") {
      return new Response(JSON.stringify({ error: "missing_fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const result = await ctx.runMutation(internal.endpoints.removeForUser, {
        slug: body.slug,
        userId: body.userId,
      });
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("[cli/endpoints DELETE]", error);
      return new Response(JSON.stringify({ error: "Failed to delete endpoint" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

// Get single request for user
http.route({
  path: "/cli/requests",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authError = await verifySharedSecret(request);
    if (authError) return authError;

    const url = new URL(request.url);
    const requestId = url.searchParams.get("requestId");
    const userId = url.searchParams.get("userId");

    if (!requestId || !userId) {
      return new Response(JSON.stringify({ error: "missing_params" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const result = await ctx.runQuery(internal.requests.getForUser, {
        requestId: requestId as Id<"requests">,
        userId: userId as Id<"users">,
      });
      if (!result) {
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("[cli/requests GET]", error);
      return new Response(JSON.stringify({ error: "Failed to get request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

// Get requests since timestamp for SSE polling
http.route({
  path: "/cli/requests-since",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authError = await verifySharedSecret(request);
    if (authError) return authError;

    const url = new URL(request.url);
    const endpointId = url.searchParams.get("endpointId");
    const userId = url.searchParams.get("userId");
    const afterTimestamp = url.searchParams.get("afterTimestamp");

    if (!endpointId || !userId || !afterTimestamp) {
      return new Response(JSON.stringify({ error: "missing_params" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const parsedTimestamp = Number(afterTimestamp);
    if (isNaN(parsedTimestamp)) {
      return new Response(JSON.stringify({ error: "invalid_timestamp" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const requests = await ctx.runQuery(internal.requests.listNewForUser, {
        endpointId: endpointId as Id<"endpoints">,
        userId: userId as Id<"users">,
        afterTimestamp: parsedTimestamp,
      });
      return new Response(JSON.stringify(requests), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("[cli/requests-since GET]", error);
      return new Response(JSON.stringify({ error: "Failed to get requests" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

// Get endpoint by slug with ownership check
http.route({
  path: "/cli/endpoint-by-slug",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authError = await verifySharedSecret(request);
    if (authError) return authError;

    const url = new URL(request.url);
    const slug = url.searchParams.get("slug");
    const userId = url.searchParams.get("userId");

    if (!slug || !userId) {
      return new Response(JSON.stringify({ error: "missing_params" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const endpoint = await ctx.runQuery(internal.endpoints.getBySlugForUser, {
        slug,
        userId: userId as Id<"users">,
      });
      if (!endpoint) {
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(endpoint), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("[cli/endpoint-by-slug GET]", error);
      return new Response(JSON.stringify({ error: "Failed to get endpoint" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

export default http;
