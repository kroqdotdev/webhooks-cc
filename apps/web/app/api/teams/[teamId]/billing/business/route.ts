import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { loggablePolarError, PolarConfigError } from "@/lib/polar";
import { reportError } from "@/lib/observability";
import {
  assertCanManage,
  CapacityError,
  createTeamBusinessCheckout,
  setTeamBusinessEnding,
} from "@/lib/supabase/capacity-billing";
import { TeamBillingError } from "@/lib/supabase/team-billing";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/teams/{teamId}/billing/business { action: "add" | "end" | "keep" }:
 * the Team Business add-on. "add" answers { url } (a checkout on the team's
 * customer); "end" sets it to end with the period; "keep" undoes that. The
 * owner only, with a session.
 */
export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  const { teamId } = await params;
  if (!UUID.test(teamId)) return Response.json({ error: "Team not found" }, { status: 404 });

  let action: unknown;
  try {
    action = ((await request.json()) as { action?: unknown } | null)?.action;
  } catch {
    action = undefined;
  }
  if (action !== "add" && action !== "end" && action !== "keep") {
    return Response.json({ error: "Unknown action" }, { status: 400 });
  }
  const account = { kind: "team" as const, teamId };

  try {
    await assertCanManage(account, auth.userId);
    const url =
      action === "add"
        ? await createTeamBusinessCheckout(account, auth.userId)
        : (await setTeamBusinessEnding(account, action === "end"), null);
    await auditUserAction(request, auth.userId, {
      action: "team.business_changed",
      status: 200,
      teamId,
      metadata: { action },
    });
    return url ? Response.json({ url }) : new Response(null, { status: 204 });
  } catch (error) {
    let status = 500;
    let message = "Could not change Team Business";
    if (error instanceof CapacityError) {
      status = error.status;
      message = error.message;
    } else if (error instanceof TeamBillingError) {
      status = error.code === "not_owner" ? 403 : error.code === "team_not_found" ? 404 : 400;
      message = error.message;
    } else if (error instanceof PolarConfigError) {
      reportError("Team Business misconfigured", error);
      message = "Billing is not configured";
    } else {
      reportError("Team Business change failed", loggablePolarError(error));
    }
    await auditUserAction(request, auth.userId, {
      action: "team.business_changed",
      status,
      teamId,
      reason: status === 500 ? undefined : message,
      metadata: { action },
    });
    return Response.json({ error: message }, { status });
  }
}
