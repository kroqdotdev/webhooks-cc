import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { parseJsonBody } from "@/lib/request-validation";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { MAX_REPLAY, replayRequests, requestIdsInRange } from "@/lib/replay";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";
import { reportError } from "@/lib/observability";

/**
 * POST /api/endpoints/{slug}/replay: sends the endpoint's requests received
 * between `since` and `until` (milliseconds; `kind` "email" or "http"
 * optional) through its destinations again, oldest first, at most 500.
 * Owner only.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  const rateLimit = await checkRateLimitWithInfo(request, "replay", 10);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  const parsed = await parseJsonBody(request);
  if ("error" in parsed) return parsed.error;
  const body = (parsed.data ?? {}) as Record<string, unknown>;
  const millis = (value: unknown) =>
    value === undefined || value === null
      ? null
      : typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
  const since = millis(body.since);
  const until = millis(body.until);
  if (since === undefined || until === undefined) {
    return reply({ error: "since and until are millisecond timestamps" }, 400);
  }
  if (
    body.kind !== undefined &&
    body.kind !== null &&
    body.kind !== "email" &&
    body.kind !== "http"
  ) {
    return reply({ error: 'kind is "email" or "http"' }, 400);
  }

  const access = await resolveEndpointAccess(auth.userId, slug);
  if (!access?.isOwner) return reply({ error: "Endpoint not found" }, 404);

  try {
    const ids = await requestIdsInRange(access.endpointId, {
      since,
      until,
      kind: (body.kind as "email" | "http" | null | undefined) ?? null,
    });
    const queued = await replayRequests(access.endpointId, ids);
    await auditUserAction(request, auth.userId, {
      action: "endpoint.replayed",
      status: 200,
      targetId: slug,
      metadata: { requests: ids.length, queued },
    });
    return reply({ requests: ids.length, queued, limit: MAX_REPLAY });
  } catch (error) {
    reportError("Failed to replay requests", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
