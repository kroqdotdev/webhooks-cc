import { authenticateSessionRequest } from "@/lib/api-auth";
import { describePolarError, loggablePolarError, PolarConfigError } from "@/lib/polar";
import { createTeamCheckout, TeamBillingError } from "@/lib/supabase/team-billing";
import { ERROR_STATUS } from "../shared";

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;

  // A missing or non-numeric seat count becomes NaN, which createTeamCheckout
  // rejects as invalid_seats — one place owns the seat range.
  let seats: number;
  try {
    const body = (await request.json()) as { seats?: unknown };
    seats = typeof body.seats === "number" ? body.seats : NaN;
  } catch {
    seats = NaN;
  }

  try {
    const url = await createTeamCheckout(auth.userId, teamId, seats);
    return Response.json({ url });
  } catch (error) {
    if (error instanceof TeamBillingError) {
      return Response.json({ error: error.message }, { status: ERROR_STATUS[error.code] ?? 400 });
    }

    if (error instanceof PolarConfigError) {
      console.error("Team checkout misconfigured:", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }

    console.error("Team checkout failed:", loggablePolarError(error));
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
