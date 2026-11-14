import { countBearerRead, extractBearerToken, validateBearerTokenWithPlan } from "@/lib/api-auth";
import {
  checkRateLimitByKeyWithInfo,
  checkRateLimitWithInfo,
  applyRateLimitHeaders,
  type RateLimitInfo,
} from "@/lib/rate-limit";
import {
  countSearchRequests,
  InvalidSearchCursorError,
  isRequestKind,
} from "@/lib/supabase/search";
import { SearchBusyError } from "@/lib/search-gate";
import {
  applySearchProgressHeaders,
  isPagedSearch,
  MAX_SEARCH_TERM_LENGTH,
  parseSearchTime,
  reportSearch,
  runBoundedSearch,
} from "@/lib/search-request-params";
import { reportError } from "@/lib/observability";

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
      const agentLimit = await checkRateLimitWithInfo(
        request,
        "search-count-unclaimed",
        60,
        10 * 60_000
      );
      if (agentLimit.response) return agentLimit.response;
      return Response.json(
        { error: "This operation requires a claimed account." },
        { status: 403 }
      );
    }

    const userId = validated.userId;
    const plan = validated.plan;

    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor")?.trim() || undefined;
    // Counting on from a cursor has its own, larger allowance (see the list
    // route).
    rateLimit = cursor
      ? await checkRateLimitByKeyWithInfo(`search-count-more:${userId}`, 300, 10 * 60_000)
      : await checkRateLimitByKeyWithInfo(`search-count:${userId}`, 120, 10 * 60_000);
    if (rateLimit.response) {
      return rateLimit.response;
    }

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
    const slug = url.searchParams.get("slug") ?? undefined;
    const q = url.searchParams.get("q") ?? undefined;
    if (q && q.length > MAX_SEARCH_TERM_LENGTH) {
      return applyRateLimitHeaders(
        Response.json({ error: "invalid_q" }, { status: 400 }),
        rateLimit
      );
    }
    const paged = isPagedSearch(url.searchParams);
    // A count without a term or method is exact. Any other covers what the
    // time budget reached: `exact` says whether that was everything, and
    // `cursor` counts on from there (the counts add up).
    const { result, waitedMs, ranMs } = await runBoundedSearch({
      userId,
      signal: request.signal,
      paged,
      run: ({ budgetMs, cancelToken }) =>
        countSearchRequests({
          userId,
          plan,
          slug,
          method: url.searchParams.get("method") ?? undefined,
          kind: kind ?? undefined,
          q,
          from,
          to,
          cursor,
          budgetMs,
          cancelToken,
        }),
    });
    reportSearch({
      userId,
      kind: "count",
      scoped: Boolean(slug?.trim()),
      hasTerm: Boolean(q?.trim()),
      continued: Boolean(cursor),
      paged,
      complete: result.exact,
      slices: result.slices,
      results: result.count,
      durationMs: ranMs,
      waitedMs,
    });

    return applyRateLimitHeaders(
      applySearchProgressHeaders(
        Response.json({
          count: result.count,
          exact: result.exact,
          searchedUntil: result.searchedUntil,
          cursor: result.cursor,
        }),
        { complete: result.exact, searchedUntil: result.searchedUntil, cursor: result.cursor }
      ),
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
      return new Response(null, { status: 499 });
    }
    reportError("Search count API route error", err);
    const response = Response.json({ error: "Internal server error" }, { status: 500 });
    return rateLimit ? applyRateLimitHeaders(response, rateLimit) : response;
  }
}
