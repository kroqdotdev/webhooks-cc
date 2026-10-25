import { authenticateRequestRequireUser } from "@/lib/api-auth";
import {
  isDeliveryCursor,
  listRecentDeliveries,
  type DeliveryStatusFilter,
} from "@/lib/supabase/forwarding";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";
import { reportError } from "@/lib/observability";

const STATUS_FILTERS: readonly DeliveryStatusFilter[] = ["all", "pending", "failed", "skipped"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The endpoint's deliveries, newest first, for its owner: `limit` (up to
 * 100), `status` (all, pending, failed or skipped), `destination` (one
 * destination's id) and `before` (a row's cursor, for older rows).
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  const access = await resolveEndpointAccess(auth.userId, slug);
  if (!access?.isOwner) return Response.json({ error: "Endpoint not found" }, { status: 404 });

  const search = new URL(request.url).searchParams;
  const limit = Number(search.get("limit") ?? "5");
  const status = (search.get("status") ?? "all") as DeliveryStatusFilter;
  if (!STATUS_FILTERS.includes(status)) {
    return Response.json(
      { error: "status must be all, pending, failed or skipped" },
      { status: 400 }
    );
  }
  const destinationId = search.get("destination");
  if (destinationId !== null && !UUID.test(destinationId)) {
    return Response.json({ error: "Invalid destination" }, { status: 400 });
  }
  const before = search.get("before");
  if (before !== null && !isDeliveryCursor(before)) {
    return Response.json({ error: "Invalid before" }, { status: 400 });
  }
  try {
    return Response.json(
      await listRecentDeliveries(access.endpointId, {
        limit: Number.isFinite(limit) ? Math.trunc(limit) : 5,
        status,
        before,
        destinationId,
      })
    );
  } catch (error) {
    reportError("Failed to list deliveries", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
