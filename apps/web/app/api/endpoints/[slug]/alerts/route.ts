import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { parseJsonBody } from "@/lib/request-validation";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import {
  getAlertSettings,
  listAlertEvents,
  parseAlertSettings,
  saveAlertSettings,
} from "@/lib/supabase/alerts";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";
import { reportError } from "@/lib/observability";

/**
 * GET /api/endpoints/{slug}/alerts: the endpoint's alert settings and its
 * recent alerts (open ones first). PUT changes the settings. Owner only:
 * alerts email the owner and post to the owner's destinations.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;
  const access = await resolveEndpointAccess(auth.userId, slug);
  if (!access?.isOwner) return Response.json({ error: "Endpoint not found" }, { status: 404 });
  try {
    const [settings, events] = await Promise.all([
      getAlertSettings(access.endpointId),
      listAlertEvents(access.endpointId),
    ]);
    return Response.json({ settings, events });
  } catch (error) {
    reportError("Failed to read alerts", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  const rateLimit = await checkRateLimitWithInfo(request, "alerts", 60);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  const parsed = await parseJsonBody(request);
  if ("error" in parsed) return parsed.error;
  if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    return reply({ error: "Send the settings as a JSON object." }, 400);
  }

  const access = await resolveEndpointAccess(auth.userId, slug);
  if (!access?.isOwner) return reply({ error: "Endpoint not found" }, 404);
  try {
    const next = parseAlertSettings(
      parsed.data as Record<string, unknown>,
      await getAlertSettings(access.endpointId)
    );
    if (typeof next === "string") return reply({ error: next }, 400);
    const settings = await saveAlertSettings(access.endpointId, next);
    await auditUserAction(request, auth.userId, {
      action: "endpoint.alerts_updated",
      status: 200,
      targetId: slug,
      metadata: { enabled: settings.enabled },
    });
    return reply({ settings });
  } catch (error) {
    reportError("Failed to save alerts", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
