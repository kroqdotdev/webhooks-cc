import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { listDestinations } from "@/lib/supabase/destinations";
import {
  listDeliveriesForRequest,
  queueDestinationRedelivery,
  queueRedelivery,
} from "@/lib/supabase/forwarding";
import { getRequestByIdForUser } from "@/lib/supabase/requests";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";
import { reportError } from "@/lib/observability";

/** The scheme and host of a URL: its path and query may hold a token. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * Every forwarded copy of one captured request, with its attempts. Anyone who
 * can read it; only the owner sees the destination's path, which may hold a
 * token (team members get the host).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { id } = await params;

  try {
    const captured = await getRequestByIdForUser(auth.userId, id);
    if (!captured) return Response.json({ error: "Request not found" }, { status: 404 });
    const deliveries = await listDeliveriesForRequest(captured.id);
    const { data: endpoint, error } = await createAdminClient()
      .from("endpoints")
      .select("user_id")
      .eq("id", captured.endpointId)
      .maybeSingle();
    if (error) throw error;
    if (endpoint?.user_id === auth.userId) return Response.json(deliveries);
    return Response.json(
      deliveries.map((delivery) => ({
        ...delivery,
        target: delivery.target ? delivery.target.split("/")[0] : null,
        destination: delivery.destination
          ? { ...delivery.destination, url: originOf(delivery.destination.url) }
          : null,
      }))
    );
  } catch (error) {
    reportError("Failed to list deliveries", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * Forwards the request (HTTP or email) again now: to one destination
 * (`{ "destinationId": "..." }`), or to every destination that takes its
 * kind. Owner only.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { id } = await params;

  const rateLimit = await checkRateLimitWithInfo(request, "email-redeliver", 30);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  let destinationId: string | null = null;
  try {
    const text = await request.text();
    const parsed = text ? (JSON.parse(text) as { destinationId?: unknown }) : {};
    if (parsed.destinationId !== undefined && parsed.destinationId !== null) {
      if (typeof parsed.destinationId !== "string") {
        return reply({ error: "destinationId must be a destination id." }, 400);
      }
      destinationId = parsed.destinationId;
    }
  } catch {
    return reply({ error: "Send JSON, or no body." }, 400);
  }

  try {
    const captured = await getRequestByIdForUser(auth.userId, id);
    if (!captured) return reply({ error: "Request not found" }, 404);
    const { data: endpoint, error } = await createAdminClient()
      .from("endpoints")
      .select("slug")
      .eq("id", captured.endpointId)
      .maybeSingle();
    if (error) throw error;
    const access = endpoint ? await resolveEndpointAccess(auth.userId, endpoint.slug) : null;
    if (!endpoint || !access?.isOwner) return reply({ error: "Request not found" }, 404);

    if (captured.kind === "email") {
      // Its deliveries go once the layouts have read it; one sent now would
      // lack the parsed result, and the parse would queue it again.
      const { data: parse, error: parseError } = await createAdminClient()
        .from("request_parses")
        .select("status")
        .eq("request_id", captured.id)
        .maybeSingle<{ status: string }>();
      if (parseError) throw parseError;
      if (parse?.status === "pending") {
        return reply(
          { error: "This email is still being parsed; its deliveries go when it is done." },
          409
        );
      }
    }

    const destinations = await listDestinations(captured.endpointId);
    const takesKind = (destination: (typeof destinations)[number]) =>
      destination.enabled && (captured.kind === "email" ? destination.email : destination.http);
    const what = captured.kind === "email" ? "emails" : "HTTP requests";
    let deliveryId: string | null;
    if (destinationId) {
      const destination = destinations.find((candidate) => candidate.id === destinationId);
      if (!destination) return reply({ error: "That destination is not on this endpoint." }, 404);
      if (!takesKind(destination)) {
        return reply({ error: `Switch that destination on, and let it take ${what}, first.` }, 409);
      }
      deliveryId = await queueDestinationRedelivery(captured.id, destination.id);
    } else {
      if (!destinations.some(takesKind)) {
        return reply({ error: `Add a destination that takes ${what} first.` }, 409);
      }
      deliveryId = await queueRedelivery(captured.id, captured.endpointId);
    }
    if (!deliveryId) return reply({ error: `No destination takes ${what} now.` }, 409);
    await auditUserAction(request, auth.userId, {
      action: captured.kind === "email" ? "email.redelivery_queued" : "request.redelivery_queued",
      status: 200,
      targetId: endpoint.slug,
      metadata: { requestId: captured.id, ...(destinationId ? { destinationId } : {}) },
    });
    return reply({ id: deliveryId });
  } catch (error) {
    reportError("Failed to queue a redelivery", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
