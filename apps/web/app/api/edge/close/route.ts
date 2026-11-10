import { fromEdge, notEdge } from "@/lib/tunnels/edge-auth";
import { closeShare } from "@/lib/tunnels/shares";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The edge says a run has closed, and why. */
export async function POST(request: Request) {
  if (!fromEdge(request)) return notEdge();
  const body = (await request.json().catch(() => ({}))) as {
    shareId?: unknown;
    reason?: unknown;
  };
  if (typeof body.shareId !== "string" || !UUID.test(body.shareId))
    return Response.json({ error: "Missing shareId." }, { status: 400 });
  await closeShare(body.shareId, typeof body.reason === "string" ? body.reason : "closed");
  return Response.json({ ok: true });
}
