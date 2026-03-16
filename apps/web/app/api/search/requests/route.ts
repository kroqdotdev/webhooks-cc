import { extractBearerToken, validateBearerTokenWithPlan } from "@/lib/api-auth";
import { checkRateLimitByKey } from "@/lib/rate-limit";
import { searchRequestsForUser } from "@/lib/supabase/search";
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

    const rateLimited = checkRateLimitByKey(`search:${userId}`, 60, 10 * 60_000);
    if (rateLimited) {
      return rateLimited;
    }

    const url = new URL(request.url);
    const parsedFrom = parseOptionalInteger(url.searchParams, "from");
    if (parsedFrom.error) {
      return parsedFrom.error;
    }
    const parsedTo = parseOptionalInteger(url.searchParams, "to");
    if (parsedTo.error) {
      return parsedTo.error;
    }
    const parsedLimit = parseOptionalInteger(url.searchParams, "limit");
    if (parsedLimit.error) {
      return parsedLimit.error;
    }
    const parsedOffset = parseOptionalInteger(url.searchParams, "offset");
    if (parsedOffset.error) {
      return parsedOffset.error;
    }

    const order = url.searchParams.get("order");
    const data = await searchRequestsForUser({
      userId,
      plan,
      slug: url.searchParams.get("slug") ?? undefined,
      method: url.searchParams.get("method") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      from: parsedFrom.value,
      to: parsedTo.value,
      limit: parsedLimit.value,
      offset: parsedOffset.value,
      order: order === "asc" ? "asc" : "desc",
    });

    return Response.json(data);
  } catch (err) {
    sendError(err instanceof Error ? err : new Error(String(err)));
    console.error("Search API route error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
