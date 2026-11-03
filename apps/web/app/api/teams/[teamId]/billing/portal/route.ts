import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { loggablePolarError, PolarConfigError } from "@/lib/polar";
import { createTeamCustomerPortal, TeamBillingError } from "@/lib/supabase/team-billing";
import { ERROR_STATUS } from "../shared";
import { reportError } from "@/lib/observability";

/**
 * A link into Polar's customer portal for the team (invoices, receipts,
 * payment method), for its owner. Session only, as for the account's own.
 */
export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;

  try {
    const url = await createTeamCustomerPortal(auth.userId, teamId);
    await auditUserAction(request, auth.userId, {
      action: "team.billing_portal_opened",
      status: 200,
      teamId,
    });
    return Response.json({ url });
  } catch (error) {
    if (error instanceof TeamBillingError) {
      const status = ERROR_STATUS[error.code] ?? 400;
      await auditUserAction(request, auth.userId, {
        action: "team.billing_portal_opened",
        status,
        reason: error.message,
        teamId,
        metadata: { code: error.code },
      });
      return Response.json({ error: error.message }, { status });
    }

    await auditUserAction(request, auth.userId, {
      action: "team.billing_portal_opened",
      status: 500,
      teamId,
    });

    if (error instanceof PolarConfigError) {
      reportError("Team billing portal misconfigured", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }

    reportError("Team billing portal failed", loggablePolarError(error));
    return Response.json({ error: "Could not open billing. Please try again." }, { status: 500 });
  }
}
