import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability";
import { endRunsWithoutAccess } from "@/lib/tunnels/access";
import { enforcePlans } from "@/lib/tunnels/enforce";
import { fromEdge, notEdge } from "@/lib/tunnels/edge-auth";
import { later } from "@/lib/tunnels/later";
import { gateVersions } from "@/lib/tunnels/passwords";
import { tellFor } from "@/lib/tunnels/stops";
import { overAllowance, recordUsage, tellPaused } from "@/lib/tunnels/usage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A run open this long that the edge does not list has lost its close. */
const UNHELD_AFTER_SECONDS = 60;

/**
 * Every 30 seconds the edge lists the runs it holds and hands over what
 * visitors took, in batches it numbers (lib/tunnels/usage.ts). The answer is
 * the runs that have ended here (stopped while the edge was not told, past
 * their plan's time, no longer covered by the plan, gone with their account,
 * or without the access they were opened with), with the words for the CLI;
 * the password version each live preview is behind, in case a change missed
 * it; and the accounts past their plan's data for the month, whose previews
 * the edge pauses. Runs open here that the edge no longer lists end too.
 */
export async function POST(request: Request) {
  if (!fromEdge(request)) return notEdge();
  const sent: unknown = await request.json().catch(() => ({}));
  const body = (typeof sent === "object" && sent !== null ? sent : {}) as {
    shareIds?: unknown;
    batches?: unknown;
  };
  await recordUsage(body.batches);
  const over = await overAllowance();
  later(() => tellPaused(over).catch((err) => reportError("Failed to tell paused previews", err)));

  // One box holds far fewer; the cap keeps the query bounded.
  const ids = (
    Array.isArray(body.shareIds)
      ? body.shareIds.filter((id): id is string => typeof id === "string" && UUID.test(id))
      : []
  ).slice(0, 5_000);

  const admin = createAdminClient();
  // Runs open here that the edge no longer holds: a close that never arrived
  // (a redeploy, a failed call, an open answered after the edge gave up).
  // Left open they would hold a slot, and a live endpoint would answer 502
  // for good. They end as 'closed', so a live one gets its usual grace.
  // Runs younger than a minute may not be in the edge's list yet.
  const { error: unheldError } = await admin.rpc("tunnel_end_unheld", {
    p_held: ids,
    p_min_age_seconds: UNHELD_AFTER_SECONDS,
  });
  if (unheldError) throw unheldError;
  if (ids.length === 0) return Response.json({ close: [], gates: [], over });

  // Runs whose access ended since they opened (a team left or lapsed, an
  // endpoint unshared, an agent disconnected, an account deleted), in case
  // the change itself could not reach the edge. First, so a run that lost
  // its team is told so, not that its plan changed.
  await endRunsWithoutAccess();
  // Open previews held to the plan as it is now (a downgrade, a refund, fewer
  // seats).
  await enforcePlans().catch((err) => reportError("Failed to hold tunnel runs to their plan", err));
  // Runs past their plan's time end here, so the CLI hears why.
  const { data: expired, error: expiredError } = await admin
    .from("tunnel_shares")
    .select("id")
    .in("id", ids)
    .is("ended_at", null)
    .lt("expires_at", new Date().toISOString());
  if (expiredError) throw expiredError;
  if (expired && expired.length > 0) {
    const { error } = await admin.rpc("tunnel_end_shares", {
      p_ids: expired.map((s) => s.id),
      p_reason: "time limit",
    });
    if (error) throw error;
  }

  const { data: rows, error } = await admin
    .from("tunnel_shares")
    .select("id, ended_at, end_reason")
    .in("id", ids);
  if (error) throw error;
  const known = new Map((rows ?? []).map((r) => [r.id, r]));
  const close = ids.flatMap((id) => {
    const row = known.get(id);
    if (!row) return [{ shareId: id, reason: tellFor("account deleted") }];
    if (row.ended_at) return [{ shareId: id, reason: tellFor(row.end_reason) }];
    return [];
  });
  return Response.json({ close, gates: await gateVersions(ids), over });
}
