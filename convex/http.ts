import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();

// Auth HTTP routes for OAuth callbacks
auth.addHttpRoutes(http);

// HTTP endpoint for Go receiver to capture webhook requests
http.route({
  path: "/capture",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const result = await ctx.runMutation(api.requests.capture, body);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
