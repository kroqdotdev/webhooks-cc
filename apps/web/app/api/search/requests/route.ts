import { extractBearerToken, validateApiKey } from "@/lib/api-auth";
import { serverEnv, publicEnv } from "@/lib/env";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@convex/_generated/api";

/**
 * GET /api/search/requests — Proxy search requests to the Rust receiver's
 * ClickHouse-backed /search endpoint.
 *
 * Auth: accepts either a Convex JWT (browser) or API key (CLI/SDK).
 * Injects user_id and forwards query params to the receiver.
 */
export async function GET(request: Request) {
  try {
    const token = extractBearerToken(request);
    if (!token) {
      return Response.json({ error: "Missing authorization header" }, { status: 401 });
    }

    let userId: string;

    if (token.startsWith("whcc_")) {
      // API key auth (CLI/SDK)
      const validatedUserId = await validateApiKey(token);
      if (!validatedUserId) {
        return Response.json({ error: "Invalid API key" }, { status: 401 });
      }
      userId = validatedUserId;
    } else {
      // Convex JWT auth (browser dashboard)
      const convex = new ConvexHttpClient(publicEnv().NEXT_PUBLIC_CONVEX_URL);
      convex.setAuth(token);
      const user = await convex.query(api.users.current);
      if (!user?._id) {
        return Response.json({ error: "Invalid token" }, { status: 401 });
      }
      userId = user._id;
    }

    const url = new URL(request.url);
    const receiverBase = publicEnv().NEXT_PUBLIC_WEBHOOK_URL;
    const secret = serverEnv().CAPTURE_SHARED_SECRET;

    // Build receiver search URL with user_id and forwarded params
    const searchUrl = new URL(`${receiverBase}/search`);
    searchUrl.searchParams.set("user_id", userId);

    // Forward allowed query params
    for (const key of ["slug", "method", "q", "from", "to", "limit", "offset", "order"]) {
      const value = url.searchParams.get(key);
      if (value) {
        searchUrl.searchParams.set(key, value);
      }
    }

    const resp = await fetch(searchUrl.toString(), {
      headers: {
        Authorization: `Bearer ${secret}`,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Search proxy error:", resp.status, text);
      return Response.json(
        { error: "Search request failed" },
        { status: resp.status >= 500 ? 502 : resp.status }
      );
    }

    const data: unknown = await resp.json();
    return Response.json(data);
  } catch (err) {
    console.error("Search API route error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
