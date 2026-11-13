import { createAdminClient } from "@/lib/supabase/admin";
import { fromEdge, notEdge } from "@/lib/tunnels/edge-auth";
import { gateOf, passwordMatches } from "@/lib/tunnels/passwords";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const unlockBody = z.object({ shareId: z.unknown().optional(), password: z.unknown().optional() });

/**
 * A visitor typed a password on a preview's password page. The answer says
 * whether it is right and, if so, the version the edge binds its cookie to.
 * The edge limits how often a visitor may try.
 */
export async function POST(request: Request) {
  if (!fromEdge(request)) return notEdge();
  // A body that cannot be read counts as an empty one.
  const parsed = await parseJsonBodyWith(request, unlockBody);
  const body: z.infer<typeof unlockBody> = "data" in parsed ? parsed.data : {};
  if (
    typeof body.password !== "string" ||
    typeof body.shareId !== "string" ||
    !UUID.test(body.shareId)
  )
    return Response.json({ ok: false });
  const { data: share, error } = await createAdminClient()
    .from("tunnel_shares")
    .select("id, name, user_id, password_hash, password_version")
    .eq("id", body.shareId)
    .eq("kind", "share")
    .is("ended_at", null)
    .maybeSingle();
  if (error) throw error;
  const gate = share ? await gateOf(share) : null;
  if (!gate || !(await passwordMatches(gate, body.password))) return Response.json({ ok: false });
  return Response.json({ ok: true, version: gate.version });
}
