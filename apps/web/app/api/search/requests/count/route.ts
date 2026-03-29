import { extractBearerToken, validateBearerTokenWithPlan } from "@/lib/api-auth";
import { checkRateLimitByKeyWithInfo, applyRateLimitHeaders, type RateLimitInfo } from "@/lib/rate-limit";
import { countSearchRequestsForUser } from "@/lib/supabase/search";
import { sendError } from "@appsignal/nodejs";

function parseOptionalInteger(
  searchParams: URLSearchParams,
  key: string
): { value?: number; error?: Response } {
  const raw = searchParams.get(key);
  if (raw === null) {
    return {};
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return { error: Response.json({ error: `invalid_${key}` }, { status: 400 }) };
  }

  return { value };
}

export async function GET(request: Request) {
  let rateLimit: RateLimitInfo | undefined;
  try {
    const token = extractBearerToken(request);
    if (!token) {
      return Response.json({ error: "Missing authorization header" }, { status: 401 });
    }

    const validated = await validateBearerTokenWithPlan(token);
    if (!validated) {
      return Response.json({ error: "Invalid token" }, { status: 401 });
    }

    const userId = validated.userId;
    const plan = validated.plan;

    rateLimit = checkRateLimitByKeyWithInfo(`search-count:${userId}`, 120, 10 * 60_000);
    if (rateLimit.response) {
      return rateLimit.response;
    }

    const url = new URL(request.url);
    const parsedFrom = parseOptionalInteger(url.searchParams, "from");
    if (parsedFrom.error) {
      return applyRateLimitHeaders(parsedFrom.error, rateLimit);
    }
    const parsedTo = parseOptionalInteger(url.searchParams, "to");
    if (parsedTo.error) {
      return applyRateLimitHeaders(parsedTo.error, rateLimit);
    }
    const count = await countSearchRequestsForUser({
      userId,
      plan,
      slug: url.searchParams.get("slug") ?? undefined,
      method: url.searchParams.get("method") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      from: parsedFrom.value,
      to: parsedTo.value,
    });

    return applyRateLimitHeaders(Response.json({ count }), rateLimit);
  } catch (err) {
    sendError(err instanceof Error ? err : new Error(String(err)));
    console.error("Search count API route error:", err);
    const response = Response.json({ error: "Internal server error" }, { status: 500 });
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}
