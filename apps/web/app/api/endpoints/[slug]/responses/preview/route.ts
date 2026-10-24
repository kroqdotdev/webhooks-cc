import type { MockResponse, ResponseRule } from "@webhooks-cc/sdk";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { sampleHttpRequest } from "@/lib/forwarding/sample";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { validateMockResponseField, validateResponseRules } from "@/lib/request-validation";
import { previewResponse } from "@/lib/response-preview";
import { getEndpointBySlugForUser } from "@/lib/supabase/endpoints";
import { getNewestRequestId } from "@/lib/supabase/forwarding";
import { getRequestsByIds } from "@/lib/supabase/requests";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";
import { reportError } from "@/lib/observability";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a sender would get back: runs the endpoint's response rules against a
 * captured request (`requestId`, by default the newest HTTP request, or a
 * sample when there is none) and fills in the placeholders, without sending
 * anything. `mockResponse` and `responseRules` in the body try unsaved
 * settings; left out, the saved ones apply. Anyone who can edit the
 * endpoint's responses can preview them.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  const rateLimit = await checkRateLimitWithInfo(request, "response-preview", 120);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  const access = await resolveEndpointAccess(auth.userId, slug);
  if (!access) return reply({ error: "Endpoint not found" }, 404);

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 64 * 1024) return reply({ error: "Request body too large" }, 413);
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return reply({ error: "Send a JSON object." }, 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return reply({ error: "Send a JSON object." }, 400);
  }
  if (
    body.requestId !== undefined &&
    (typeof body.requestId !== "string" || !UUID.test(body.requestId))
  ) {
    return reply({ error: "requestId must be a request id." }, 400);
  }
  const mockCheck = validateMockResponseField(body.mockResponse);
  if (!mockCheck.valid) return applyRateLimitHeaders(mockCheck.response, rateLimit);
  const rulesCheck = validateResponseRules(body.responseRules);
  if (!rulesCheck.valid) return applyRateLimitHeaders(rulesCheck.response, rateLimit);

  try {
    const endpoint = await getEndpointBySlugForUser(access.ownerId, slug);
    if (!endpoint) return reply({ error: "Endpoint not found" }, 404);

    let source = null;
    if (typeof body.requestId === "string") {
      [source] = await getRequestsByIds([body.requestId]);
      if (!source || source.endpointId !== endpoint.id) {
        return reply({ error: "That request is not on this endpoint." }, 404);
      }
    } else {
      const newestId = await getNewestRequestId(endpoint.id, "http");
      [source] = newestId ? await getRequestsByIds([newestId]) : [];
    }
    const sample = !source;
    const target = source ?? sampleHttpRequest(endpoint.id);

    const preview = previewResponse(
      {
        mockResponse:
          "mockResponse" in body
            ? ((body.mockResponse as MockResponse | null) ?? null)
            : (endpoint.mockResponse ?? null),
        responseRules:
          "responseRules" in body
            ? ((body.responseRules as ResponseRule[] | null) ?? null)
            : ((endpoint.responseRules as ResponseRule[] | undefined) ?? null),
      },
      target,
      { slug: endpoint.slug, name: endpoint.name ?? null }
    );
    return reply({
      ...preview,
      request: {
        id: sample ? null : target.id,
        method: target.method,
        path: target.path,
        receivedAt: target.receivedAt,
        sample,
      },
    });
  } catch (error) {
    reportError("Response preview failed", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
