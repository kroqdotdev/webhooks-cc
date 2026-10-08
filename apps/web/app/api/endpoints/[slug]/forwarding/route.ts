import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { getForwardSecret, rotateForwardSecret } from "@/lib/supabase/forwarding";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";

/** The forwarding secret, for the endpoint's owner to put in their handler. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  const access = await resolveEndpointAccess(auth.userId, slug);
  if (!access?.isOwner) return Response.json({ error: "Endpoint not found" }, { status: 404 });

  try {
    const secret = await getForwardSecret(auth.userId, slug);
    if (!secret) return Response.json({ error: "Forwarding has no secret yet" }, { status: 404 });
    return Response.json({ secret }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Failed to read the forwarding secret:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** Replaces the secret; deliveries from now on are signed with the new one. */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  const access = await resolveEndpointAccess(auth.userId, slug);
  if (!access?.isOwner) return Response.json({ error: "Endpoint not found" }, { status: 404 });

  try {
    const secret = await rotateForwardSecret(auth.userId, slug);
    await auditUserAction(request, auth.userId, {
      action: "endpoint.forward_secret_rotated",
      status: secret ? 200 : 404,
      targetId: slug,
    });
    if (!secret) return Response.json({ error: "Endpoint not found" }, { status: 404 });
    return Response.json({ secret }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Failed to rotate the forwarding secret:", error);
    await auditUserAction(request, auth.userId, {
      action: "endpoint.forward_secret_rotated",
      status: 500,
      targetId: slug,
    });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
