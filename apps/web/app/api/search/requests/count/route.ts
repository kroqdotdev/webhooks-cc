import { extractBearerToken, validateApiKeyWithPlan } from "@/lib/api-auth";
import { serverEnv, publicEnv } from "@/lib/env";
import { checkRateLimitByKey } from "@/lib/rate-limit";
import * as Sentry from "@sentry/nextjs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@convex/_generated/api";

/**
 * GET /api/search/requests/count — Proxy retained request counts to the Rust receiver's
 * ClickHouse-backed /search/count endpoint.
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
    let plan: "free" | "pro" | undefined;

    if (token.startsWith("whcc_")) {
      const validated = await validateApiKeyWithPlan(token);
      if (!validated) {
        return Response.json({ error: "Invalid API key" }, { status: 401 });
      }
      userId = validated.userId;
      plan = validated.plan;
    } else {
      const convex = new ConvexHttpClient(publicEnv().NEXT_PUBLIC_CONVEX_URL);
      convex.setAuth(token);
      try {
        const user = await convex.query(api.users.current);
        if (!user?._id) {
          return Response.json({ error: "Invalid token" }, { status: 401 });
        }
        userId = user._id;
        plan = user.plan === "free" || user.plan === "pro" ? user.plan : undefined;
      } catch (authErr: unknown) {
        const msg = authErr instanceof Error ? authErr.message : String(authErr);
        if (msg.includes("Unauthenticated") || msg.includes("OIDC token")) {
          return Response.json({ error: "Token expired" }, { status: 401 });
        }
        throw authErr;
      }
    }

    const rateLimited = checkRateLimitByKey(`search-count:${userId}`, 120, 10 * 60_000);
    if (rateLimited) {
      return rateLimited;
    }

    const url = new URL(request.url);
    const receiverBase = publicEnv().NEXT_PUBLIC_WEBHOOK_URL;
    const secret = serverEnv().CAPTURE_SHARED_SECRET;

    const countUrl = new URL(`${receiverBase}/search/count`);
    countUrl.searchParams.set("user_id", userId);
    if (plan) {
      countUrl.searchParams.set("plan", plan);
    }

    for (const key of ["slug", "method", "q", "from", "to"]) {
      const value = url.searchParams.get(key);
      if (value) {
        countUrl.searchParams.set(key, value);
      }
    }

    const resp = await fetch(countUrl.toString(), {
      headers: {
        Authorization: `Bearer ${secret}`,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Search count proxy error:", resp.status, text);
      return Response.json(
        { error: "Search count request failed" },
        { status: resp.status >= 500 ? 502 : resp.status }
      );
    }

    const data: unknown = await resp.json();
    if (
      typeof data !== "object" ||
      data === null ||
      !("count" in data) ||
      typeof (data as { count: unknown }).count !== "number"
    ) {
      return Response.json({ error: "Unexpected response format" }, { status: 502 });
    }

    return Response.json({ count: (data as { count: number }).count });
  } catch (err) {
    Sentry.captureException(err);
    console.error("Search count API route error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
