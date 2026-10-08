import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { listDeliveriesForRequest, queueRedelivery } from "@/lib/supabase/forwarding";
import { getRequestByIdForUser } from "@/lib/supabase/requests";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";

/** Every forwarded copy of one email, with its attempts. Anyone who can read the email. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { id } = await params;

  try {
    const captured = await getRequestByIdForUser(auth.userId, id);
    if (!captured) return Response.json({ error: "Request not found" }, { status: 404 });
    return Response.json(await listDeliveriesForRequest(captured.id));
  } catch (error) {
    console.error("Failed to list deliveries:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** Forwards the email again, with the endpoint's current settings. Owner only. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { id } = await params;

  const rateLimit = await checkRateLimitWithInfo(request, "email-redeliver", 30);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  try {
    const captured = await getRequestByIdForUser(auth.userId, id);
    if (!captured || captured.kind !== "email") {
      return reply({ error: "Email not found" }, 404);
    }
    const { data: endpoint, error } = await createAdminClient()
      .from("endpoints")
      .select("slug, forward_enabled")
      .eq("id", captured.endpointId)
      .maybeSingle();
    if (error) throw error;
    const access = endpoint ? await resolveEndpointAccess(auth.userId, endpoint.slug) : null;
    if (!endpoint || !access?.isOwner) return reply({ error: "Email not found" }, 404);
    if (!endpoint.forward_enabled) {
      return reply({ error: "Turn forwarding on for this endpoint first." }, 409);
    }

    const deliveryId = await queueRedelivery(captured.id, captured.endpointId);
    if (!deliveryId) {
      return reply({ error: "Turn forwarding on for this endpoint first." }, 409);
    }
    await auditUserAction(request, auth.userId, {
      action: "email.redelivery_queued",
      status: 200,
      targetId: endpoint.slug,
      metadata: { requestId: captured.id },
    });
    return reply({ id: deliveryId });
  } catch (error) {
    console.error("Failed to queue a redelivery:", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
