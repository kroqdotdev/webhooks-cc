import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { getDeliverySummary } from "@/lib/supabase/forwarding";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";
import { reportError } from "@/lib/observability";
import { isUuid } from "@/lib/uuid";

/**
 * Delivery counts for the endpoint's owner: delivered and failed in the last
 * 24 hours, waiting now, and the totals behind the log's filters. With
 * `destination` (one destination's id, as the log takes it) the counts are
 * that destination's only, so a filtered log and its summary agree.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  const access = await resolveEndpointAccess(auth.userId, slug);
  if (!access?.isOwner) return Response.json({ error: "Endpoint not found" }, { status: 404 });

  const destinationId = new URL(request.url).searchParams.get("destination");
  if (destinationId !== null && !isUuid(destinationId)) {
    return Response.json({ error: "Invalid destination" }, { status: 400 });
  }

  try {
    return Response.json(await getDeliverySummary(access.endpointId, Date.now(), destinationId));
  } catch (error) {
    reportError("Failed to count deliveries", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
