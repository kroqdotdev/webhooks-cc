import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { describePolarError, loggablePolarError, PolarConfigError } from "@/lib/polar";
import { createTeamCheckout, TeamBillingError } from "@/lib/supabase/team-billing";
import { ERROR_STATUS, isInterval, isTeamPlan } from "../shared";
import { reportError } from "@/lib/observability";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

const checkoutBody = z.object({
  seats: z.unknown().optional(),
  plan: z.unknown().optional(),
  interval: z.unknown().optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;

  // A missing or non-numeric seat count becomes NaN, which createTeamCheckout
  // rejects as invalid_seats: one place owns the seat range. The plan
  // defaults to Teams, monthly, as before plans could be picked.
  // A body that cannot be read counts as an empty one.
  const parsed = await parseJsonBodyWith(request, checkoutBody);
  const body: z.infer<typeof checkoutBody> = "data" in parsed ? parsed.data : {};
  const seats = typeof body.seats === "number" ? body.seats : NaN;
  const plan = body.plan ?? "team";
  const interval = body.interval ?? "month";
  if (!isTeamPlan(plan) || !isInterval(interval)) {
    return Response.json({ error: "Unknown plan" }, { status: 400 });
  }

  try {
    const url = await createTeamCheckout(auth.userId, teamId, seats, plan, interval);
    await auditUserAction(request, auth.userId, {
      action: "team.checkout_started",
      status: 200,
      teamId,
      metadata: { seats, plan, interval },
    });
    return Response.json({ url });
  } catch (error) {
    if (error instanceof TeamBillingError) {
      const status = ERROR_STATUS[error.code] ?? 400;
      await auditUserAction(request, auth.userId, {
        action: "team.checkout_started",
        status,
        reason: error.message,
        teamId,
        metadata: { code: error.code, seats, plan, interval },
      });
      return Response.json({ error: error.message }, { status });
    }

    await auditUserAction(request, auth.userId, {
      action: "team.checkout_started",
      status: 500,
      teamId,
      metadata: { seats, plan, interval },
    });

    if (error instanceof PolarConfigError) {
      reportError("Team checkout misconfigured", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }

    reportError("Team checkout failed", loggablePolarError(error));
    // Surface Polar validation detail (e.g. an unroutable billing email) so
    // the owner sees why instead of a bare "failed".
    const detail = describePolarError(error);
    return Response.json(
      detail
        ? { error: "Failed to start checkout", detail }
        : { error: "Failed to start checkout" },
      { status: 500 }
    );
  }
}
