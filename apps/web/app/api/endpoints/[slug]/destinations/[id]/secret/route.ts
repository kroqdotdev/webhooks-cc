import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { ownedEndpoint } from "@/lib/forwarding/destination-routes";
import { getDestinationSecret, rotateDestinationSecret } from "@/lib/supabase/destinations";
import { reportError } from "@/lib/observability";
import { isUuid } from "@/lib/uuid";

type Params = { params: Promise<{ slug: string; id: string }> };

/**
 * The destination's signing secret, which its server checks deliveries with:
 * GET reveals it, POST replaces it (deliveries are signed with the new one at
 * once). Owner only, and a signed-in session or API key.
 */
export async function GET(request: Request, { params }: Params) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug, id } = await params;
  if (!isUuid(id)) return Response.json({ error: "Destination not found" }, { status: 404 });
  try {
    const endpoint = await ownedEndpoint(auth.userId, slug);
    const secret = endpoint ? await getDestinationSecret(endpoint.id, id) : null;
    if (!secret) return Response.json({ error: "Destination not found" }, { status: 404 });
    return Response.json({ secret }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    reportError("Failed to read a destination secret", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: Params) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug, id } = await params;
  if (!isUuid(id)) return Response.json({ error: "Destination not found" }, { status: 404 });
  try {
    const endpoint = await ownedEndpoint(auth.userId, slug);
    const secret = endpoint ? await rotateDestinationSecret(endpoint.id, id) : null;
    if (!secret) return Response.json({ error: "Destination not found" }, { status: 404 });
    await auditUserAction(request, auth.userId, {
      action: "endpoint.destination_secret_rotated",
      status: 200,
      targetId: slug,
      metadata: { destinationId: id },
    });
    return Response.json({ secret }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    reportError("Failed to replace a destination secret", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
