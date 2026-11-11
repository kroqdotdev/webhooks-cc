import { fromEdge, notEdge } from "@/lib/tunnels/edge-auth";
import { closeAllOpen } from "@/lib/tunnels/shares";

/** The edge has (re)started: every run it held is gone. */
export async function POST(request: Request) {
  if (!fromEdge(request)) return notEdge();
  const closed = await closeAllOpen("edge restart");
  return Response.json({ ok: true, closed });
}
