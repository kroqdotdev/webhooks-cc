import { createAdminClient } from "@/lib/supabase/admin";
import { fromEdge, notEdge } from "@/lib/tunnels/edge-auth";
import { gateOf, passwordMatches } from "@/lib/tunnels/passwords";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A visitor typed a password on a preview's password page. The answer says
 * whether it is right and, if so, the version the edge binds its cookie to.
 * The edge limits how often a visitor may try.
 */
export async function POST(request: Request) {
  if (!fromEdge(request)) return notEdge();
  const body = (await request.json().catch(() => ({}))) as {
    shareId?: unknown;
    password?: unknown;
  };
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
