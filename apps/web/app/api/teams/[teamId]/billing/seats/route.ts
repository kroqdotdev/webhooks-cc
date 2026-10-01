import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { loggablePolarError, PolarConfigError } from "@/lib/polar";
import { TeamBillingError, updateTeamSeats } from "@/lib/supabase/team-billing";
import { ERROR_STATUS } from "../shared";

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;

  // A missing or non-numeric seat count becomes NaN, which updateTeamSeats
  // rejects as invalid_seats — one place owns the seat range.
  let seats: number;
  try {
    const body = (await request.json()) as { seats?: unknown };
    seats = typeof body.seats === "number" ? body.seats : NaN;
  } catch {
    seats = NaN;
  }

  try {
    await updateTeamSeats(auth.userId, teamId, seats);
    await auditUserAction(request, auth.userId, {
      action: "team.seats_changed",
      status: 204,
      teamId,
      metadata: { seats },
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof TeamBillingError) {
      const status = ERROR_STATUS[error.code] ?? 400;
      await auditUserAction(request, auth.userId, {
        action: "team.seats_changed",
        status,
        reason: error.message,
        teamId,
        metadata: { code: error.code, seats },
      });
      return Response.json({ error: error.message }, { status });
    }

    await auditUserAction(request, auth.userId, {
      action: "team.seats_changed",
      status: 500,
      teamId,
      metadata: { seats },
    });

    if (error instanceof PolarConfigError) {
      console.error("Team seat update misconfigured:", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }

    console.error("Team seat update failed:", loggablePolarError(error));
    return Response.json({ error: "Failed to update seats" }, { status: 500 });
  }
}
