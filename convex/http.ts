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
// nanoid generates mixed-case alphanumeric strings
const SLUG_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,48}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

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

    // Verify the authorization header matches the expected secret
    if (authHeader !== `Bearer ${expectedSecret}`) {
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

    const result = await ctx.runMutation(internal.requests.capture, body);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
