import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { queueFailedRedeliveries } from "@/lib/supabase/forwarding";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";

/**
 * Queues every request whose latest delivery failed again, oldest first,
 * with the endpoint's current settings. Owner only. Answers how many were
 * queued; at most what fits under the pending cap.
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

  try {
    const { data: endpoint, error } = await createAdminClient()
      .from("endpoints")
      .select("forward_enabled")
      .eq("id", access.endpointId)
      .maybeSingle();
    if (error) throw error;
    if (!endpoint?.forward_enabled) return reply({ error: "Turn forwarding on first." }, 409);

    const queued = await queueFailedRedeliveries(access.endpointId);
    await auditUserAction(request, auth.userId, {
      action: "endpoint.failed_deliveries_requeued",
      status: 200,
      targetId: slug,
      metadata: { queued },
    });
    return reply({ queued });
  } catch (error) {
    console.error("Failed to queue failed deliveries again:", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
