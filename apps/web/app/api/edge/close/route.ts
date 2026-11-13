import { fromEdge, notEdge } from "@/lib/tunnels/edge-auth";
import { closeShare } from "@/lib/tunnels/shares";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const closeBody = z.object({ shareId: z.unknown().optional(), reason: z.unknown().optional() });

/** The edge says a run has closed, and why. */
export async function POST(request: Request) {
  if (!fromEdge(request)) return notEdge();
  // A body that cannot be read counts as an empty one.
  const parsed = await parseJsonBodyWith(request, closeBody);
  const body: z.infer<typeof closeBody> = "data" in parsed ? parsed.data : {};
  if (typeof body.shareId !== "string" || !UUID.test(body.shareId))
    return Response.json({ error: "Missing shareId." }, { status: 400 });
  await closeShare(body.shareId, typeof body.reason === "string" ? body.reason : "closed");
  return Response.json({ ok: true });
}
