import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { listDestinations } from "@/lib/supabase/destinations";
import { queueFailedRedeliveries } from "@/lib/supabase/forwarding";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";
import { reportError } from "@/lib/observability";

/**
 * Queues every request whose latest delivery to a destination failed again,
 * oldest first, with that destination's current settings: every destination,
 * or only `?destination=<id>`. Owner only. Answers how many were queued; at
 * most what fits under each destination's pending cap.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  const rateLimit = await checkRateLimitWithInfo(request, "redeliver-failed", 10);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  const access = await resolveEndpointAccess(auth.userId, slug);
  if (!access?.isOwner) return reply({ error: "Endpoint not found" }, 404);

  const destinationId = new URL(request.url).searchParams.get("destination");
  try {
    const destinations = await listDestinations(access.endpointId);
    const chosen = destinationId
      ? destinations.filter((destination) => destination.id === destinationId)
      : destinations;
    if (destinationId && chosen.length === 0) {
      return reply({ error: "That destination is not on this endpoint." }, 404);
    }
    if (!chosen.some((destination) => destination.enabled)) {
      return reply(
        { error: destinationId ? "Switch the destination on first." : "Turn forwarding on first." },
        409
      );
    }

    const queued = await queueFailedRedeliveries(access.endpointId, destinationId);
    await auditUserAction(request, auth.userId, {
      action: "endpoint.failed_deliveries_requeued",
      status: 200,
      targetId: slug,
      metadata: { queued, ...(destinationId ? { destinationId } : {}) },
    });
    return reply({ queued });
  } catch (error) {
    reportError("Failed to queue failed deliveries again", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
