import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { listRecentDeliveries } from "@/lib/supabase/forwarding";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";

/** The endpoint's latest forwarded emails, for its owner's Settings tab. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;

  const access = await resolveEndpointAccess(auth.userId, slug);
  if (!access?.isOwner) return Response.json({ error: "Endpoint not found" }, { status: 404 });

  const limit = Number(new URL(request.url).searchParams.get("limit") ?? "5");
  try {
    return Response.json(
      await listRecentDeliveries(access.endpointId, Number.isFinite(limit) ? limit : 5)
    );
  } catch (error) {
    console.error("Failed to list deliveries:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
