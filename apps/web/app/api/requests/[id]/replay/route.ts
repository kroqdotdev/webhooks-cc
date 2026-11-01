import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { replayRequests } from "@/lib/replay";
import { getRetainedRequestsByIds } from "@/lib/supabase/requests";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability";

/**
 * POST /api/requests/{id}/replay: sends one captured request through its
 * endpoint's destinations again, with their current settings. Owner only.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { id } = await params;

  const rateLimit = await checkRateLimitWithInfo(request, "replay-one", 60);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  if (!/^[0-9a-f-]{36}$/i.test(id)) return reply({ error: "not_found" }, 404);
  try {
    const { data, error } = await createAdminClient()
      .from("requests")
      .select("id, endpoint_id, endpoints!inner(user_id, slug)")
      .eq("id", id)
      .maybeSingle<{
        id: string;
        endpoint_id: string;
        endpoints: { user_id: string | null; slug: string };
      }>();
    if (error) throw error;
    if (!data || data.endpoints.user_id !== auth.userId) return reply({ error: "not_found" }, 404);
    // Past retention it is gone, whether or not the cleanup has deleted it yet.
    const retained = await getRetainedRequestsByIds(data.endpoint_id, [data.id]);
    if (retained.length === 0) return reply({ error: "not_found" }, 404);
    const queued = await replayRequests(data.endpoint_id, [data.id]);
    await auditUserAction(request, auth.userId, {
      action: "request.replayed",
      status: 200,
      targetId: data.endpoints.slug,
      metadata: { requestId: data.id, queued },
    });
    return reply({ queued: queued > 0 });
  } catch (error) {
    reportError("Failed to replay a request", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
