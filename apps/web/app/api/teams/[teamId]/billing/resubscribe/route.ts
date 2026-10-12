import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { loggablePolarError, PolarConfigError } from "@/lib/polar";
import { resubscribeTeam, TeamBillingError } from "@/lib/supabase/team-billing";
import { ERROR_STATUS } from "../shared";
import { reportError } from "@/lib/observability";

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;

  try {
    await resubscribeTeam(auth.userId, teamId);
    await auditUserAction(request, auth.userId, {
      action: "team.subscription_resumed",
      status: 204,
      teamId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof TeamBillingError) {
      const status = ERROR_STATUS[error.code] ?? 400;
      await auditUserAction(request, auth.userId, {
        action: "team.subscription_resumed",
        status,
        reason: error.message,
        teamId,
        metadata: { code: error.code },
      });
      return Response.json({ error: error.message }, { status });
    }

    await auditUserAction(request, auth.userId, {
      action: "team.subscription_resumed",
      status: 500,
      teamId,
    });

    if (error instanceof PolarConfigError) {
      reportError("Team resubscribe misconfigured", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }

    reportError("Team resubscribe failed", loggablePolarError(error));
    return Response.json({ error: "Failed to reactivate subscription" }, { status: 500 });
  }
}
