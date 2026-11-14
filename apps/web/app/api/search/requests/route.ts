import { countBearerRead, extractBearerToken, validateBearerTokenWithPlan } from "@/lib/api-auth";
import {
  checkRateLimitByKeyWithInfo,
  checkRateLimitWithInfo,
  applyRateLimitHeaders,
  type RateLimitInfo,
} from "@/lib/rate-limit";
import { InvalidSearchCursorError, isRequestKind, searchRequestPage } from "@/lib/supabase/search";
import { SearchBusyError, withSearchSlot } from "@/lib/search-gate";
import {
  applySearchProgressHeaders,
  parseSearchTime,
  reportSearch,
} from "@/lib/search-request-params";
import { reportError } from "@/lib/observability";

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
    countBearerRead(request, token, validated);
    // Unowned, agent-issued keys (auth.md anonymous flow) have no user to scope
    // the search to. Rate-limit by IP BEFORE rejecting — the per-user limiter
    // below never runs for them, so without this an unclaimed key could hammer
    // this endpoint (and its bearer validation) unthrottled.
    if (validated.userId === null) {
      const agentLimit = await checkRateLimitWithInfo(request, "search-unclaimed", 60, 10 * 60_000);
      if (agentLimit.response) return agentLimit.response;
      return Response.json(
        { error: "This operation requires a claimed account." },
        { status: 403 }
      );
    }

    const userId = validated.userId;
    const plan = validated.plan;

    rateLimit = await checkRateLimitByKeyWithInfo(`search:${userId}`, 60, 10 * 60_000);
    if (rateLimit.response) {
      return rateLimit.response;
    }

    const url = new URL(request.url);
    // Epoch ms, or a duration back from now ("1h").
    const from = parseSearchTime(url.searchParams.get("from"));
    if (from === null) {
      return applyRateLimitHeaders(
        Response.json({ error: "invalid_from" }, { status: 400 }),
        rateLimit
      );
    }
    const to = parseSearchTime(url.searchParams.get("to"));
    if (to === null) {
      return applyRateLimitHeaders(
        Response.json({ error: "invalid_to" }, { status: 400 }),
        rateLimit
      );
    }
    const kind = url.searchParams.get("kind");
    if (kind !== null && !isRequestKind(kind)) {
      return applyRateLimitHeaders(
        Response.json({ error: "invalid_kind" }, { status: 400 }),
        rateLimit
      );
    }
    const parsedLimit = parseOptionalInteger(url.searchParams, "limit");
    if (parsedLimit.error) {
      return applyRateLimitHeaders(parsedLimit.error, rateLimit);
    }
    const parsedOffset = parseOptionalInteger(url.searchParams, "offset");
    if (parsedOffset.error) {
      return applyRateLimitHeaders(parsedOffset.error, rateLimit);
    }

    const order = url.searchParams.get("order");
    const slug = url.searchParams.get("slug") ?? undefined;
    const q = url.searchParams.get("q") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const started = performance.now();
    // A search answers within its time budget with what it found and where it
    // stopped; the body stays the array older clients read, and the rest
    // travels in X-Search-* headers.
    const page = await withSearchSlot(userId, () =>
      searchRequestPage({
        userId,
        plan,
        slug,
        method: url.searchParams.get("method") ?? undefined,
        kind: kind ?? undefined,
        q,
        from,
        to,
        limit: parsedLimit.value,
        offset: parsedOffset.value,
        order: order === "asc" ? "asc" : "desc",
        cursor,
      })
    );
    reportSearch({
      userId,
      kind: "list",
      scoped: Boolean(slug?.trim()),
      hasTerm: Boolean(q?.trim()),
      continued: Boolean(cursor?.trim()),
      complete: page.complete,
      slices: page.slices,
      results: page.requests.length,
      durationMs: performance.now() - started,
    });

    return applyRateLimitHeaders(
      applySearchProgressHeaders(Response.json(page.requests), page),
      rateLimit
    );
  } catch (err) {
    if (err instanceof InvalidSearchCursorError) {
      const response = Response.json({ error: "invalid_cursor" }, { status: 400 });
      return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
    }
    if (err instanceof SearchBusyError) {
      const response = Response.json(
        { error: "search_busy", message: err.message },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSeconds) } }
      );
      return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
    }
    if (request.signal.aborted) {
      // The client went away; nobody reads this answer.
      return new Response(null, { status: 499 });
    }
    reportError("Search API route error", err);
    const response = Response.json({ error: "Internal server error" }, { status: 500 });
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}
