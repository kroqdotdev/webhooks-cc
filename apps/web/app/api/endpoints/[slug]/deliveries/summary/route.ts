import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { getDeliverySummary } from "@/lib/supabase/forwarding";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";

/**
 * Delivery counts for the endpoint's owner: delivered and failed in the last
 * 24 hours, waiting now, and the totals behind the log's filters.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  const access = await resolveEndpointAccess(auth.userId, slug);
  if (!access?.isOwner) return Response.json({ error: "Endpoint not found" }, { status: 404 });

  try {
    return Response.json(await getDeliverySummary(access.endpointId));
  } catch (error) {
    console.error("Failed to count deliveries:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
