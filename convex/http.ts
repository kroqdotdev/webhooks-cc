import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();

// Auth HTTP routes for OAuth callbacks
auth.addHttpRoutes(http);

// Allowed HTTP methods for webhook capture
const ALLOWED_METHODS = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"
]);

// Valid slug format: alphanumeric with hyphens, 3-50 chars
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

// HTTP endpoint for Go receiver to capture webhook requests
http.route({
  path: "/capture",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();

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

    const result = await ctx.runMutation(api.requests.capture, body);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
