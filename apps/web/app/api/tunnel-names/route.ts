import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import { applyRateLimitHeaders, checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { SUSPENDED, sharingSuspended } from "@/lib/tunnels/accounts";
import { sharingOff, tunnelConfig } from "@/lib/tunnels/config";
import { apiNames } from "@/lib/tunnels/name-api";
import { namesOf, namesView, reserveName } from "@/lib/tunnels/names";
import { createAdminClient } from "@/lib/supabase/admin";
import { tunnelPlanOf } from "@/lib/tunnels/plan";

const READ_LIMIT = 120;
const READ_WINDOW_MS = 60_000;
const RESERVE_LIMIT = 30;
const RESERVE_WINDOW_MS = 10 * 60_000;

/** The preview names the account may use: its own and its teams'. */
export async function GET(request: Request) {
  if (!tunnelConfig()) return sharingOff();
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const rateLimit = await checkRateLimitByKeyWithInfo(
    `tunnel-names-read:${auth.userId}`,
    READ_LIMIT,
    READ_WINDOW_MS
  );
  if (rateLimit.response) return rateLimit.response;

  try {
    const plan = await tunnelPlanOf(auth.userId);
    if (!plan) return Response.json({ error: "Account not found" }, { status: 404 });
    const view = await namesView(auth.userId, plan);
    const teamNames = new Map<string, string>();
    if (plan.teamIds.length > 0) {
      const { data: teams, error } = await createAdminClient()
        .from("teams")
        .select("id, name")
        .in("id", plan.teamIds);
      if (error) throw error;
      for (const t of teams ?? []) teamNames.set(t.id, t.name);
    }
    // `limit` and `used` are the account's own names (outside teams) against
    // its plan; each team's names count against the team, in `teams`.
    return applyRateLimitHeaders(
      Response.json({
        names: await apiNames(view.names),
        limit: view.own.limit,
        used: view.own.used,
        plan: plan.key,
        teams: view.teams.map((t) => ({
          id: t.teamId,
          name: teamNames.get(t.teamId) ?? "",
          active: plan.activeTeamIds.includes(t.teamId),
          limit: t.limit,
          used: t.used,
        })),
      }),
      rateLimit
    );
  } catch (error) {
    reportError("Failed to list tunnel names", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * Keeps a preview name: `{name}`, and `{team}` (a team id) to keep it inside
 * one of the account's teams so every member may share under it.
 */
export async function POST(request: Request) {
  if (!tunnelConfig()) return sharingOff();
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const rateLimit = await checkRateLimitByKeyWithInfo(
    `tunnel-names-reserve:${auth.userId}`,
    RESERVE_LIMIT,
    RESERVE_WINDOW_MS
  );
  if (rateLimit.response) return rateLimit.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.name !== "string" || body.name.length > 100)
    return Response.json({ error: "name is required" }, { status: 400 });
  const teamId = typeof body.team === "string" && body.team ? body.team : null;

  try {
    if (await sharingSuspended(auth.userId))
      return applyRateLimitHeaders(Response.json({ error: SUSPENDED }, { status: 403 }), rateLimit);
    const plan = await tunnelPlanOf(auth.userId);
    if (!plan) return Response.json({ error: "Account not found" }, { status: 404 });
    const result = await reserveName(auth.userId, plan, body.name, teamId);
    if ("error" in result) {
      await auditUserAction(request, auth.userId, {
        action: "tunnel.name_reserved",
        status: result.status,
        reason: result.error,
        teamId,
        metadata: { name: body.name.slice(0, 40) },
      });
      return applyRateLimitHeaders(
        Response.json({ error: result.error }, { status: result.status }),
        rateLimit
      );
    }
    if (result.reserved)
      await auditUserAction(request, auth.userId, {
        action: "tunnel.name_reserved",
        status: 201,
        teamId,
        targetId: result.name,
      });
    const [shown] = await apiNames(
      (await namesOf(auth.userId, plan)).filter((n) => n.name === result.name)
    );
    return applyRateLimitHeaders(
      Response.json({ name: shown }, { status: result.reserved ? 201 : 200 }),
      rateLimit
    );
  } catch (error) {
    reportError("Failed to reserve a tunnel name", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
