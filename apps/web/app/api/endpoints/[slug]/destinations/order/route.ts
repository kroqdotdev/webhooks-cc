import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { jsonObject, ownedEndpoint } from "@/lib/forwarding/destination-routes";
import { listDestinations, reorderDestinations } from "@/lib/supabase/destinations";
import { reportError } from "@/lib/observability";

/**
 * Puts the destinations in the given order (`{ "ids": [...] }`); the order
 * is how the dashboard lists them and the order captures are queued in.
 * Owner only.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;
  const body = await jsonObject(request);
  if (body instanceof Response) return body;
  const ids = body.ids;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    return Response.json({ error: "ids must be a list of destination ids." }, { status: 400 });
  }
  try {
    const endpoint = await ownedEndpoint(auth.userId, slug);
    if (!endpoint) return Response.json({ error: "Endpoint not found" }, { status: 404 });
    const known = new Set(
      (await listDestinations(endpoint.id)).map((destination) => destination.id)
    );
    if (!ids.every((id) => known.has(id as string))) {
      return Response.json(
        { error: "Every id must be one of the endpoint's destinations." },
        { status: 400 }
      );
    }
    await reorderDestinations(endpoint.id, ids as string[]);
    await auditUserAction(request, auth.userId, {
      action: "endpoint.destinations_reordered",
      status: 200,
      targetId: slug,
    });
    return Response.json(await listDestinations(endpoint.id));
  } catch (error) {
    reportError("Failed to reorder destinations", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
