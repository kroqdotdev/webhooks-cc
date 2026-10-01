import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { checkRateLimitByKeyWithInfo, applyRateLimitHeaders } from "@/lib/rate-limit";
import { createTeam, listTeamsForUser } from "@/lib/supabase/teams";

const TEAM_CREATE_RATE_LIMIT_MAX = 10;
const TEAM_CREATE_RATE_LIMIT_WINDOW_MS = 10 * 60_000;

export async function GET(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  try {
    const teams = await listTeamsForUser(auth.userId);
    return Response.json(teams);
  } catch (error) {
    console.error("Failed to list teams:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const rateLimit = await checkRateLimitByKeyWithInfo(
    `team-create:${auth.userId}`,
    TEAM_CREATE_RATE_LIMIT_MAX,
    TEAM_CREATE_RATE_LIMIT_WINDOW_MS
  );
  if (rateLimit.response) return rateLimit.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0 || name.length > 100) {
    return Response.json({ error: "Name must be between 1 and 100 characters" }, { status: 400 });
  }

  try {
    const result = await createTeam(auth.userId, name);
    if ("error" in result) {
      await auditUserAction(request, auth.userId, {
        action: "team.created",
        status: 400,
        reason: result.error,
        metadata: { name },
      });
      return applyRateLimitHeaders(
        Response.json({ error: result.error }, { status: 400 }),
        rateLimit
      );
    }
    await auditUserAction(request, auth.userId, {
      action: "team.created",
      status: 200,
      teamId: result.id,
      metadata: { name },
    });
    return applyRateLimitHeaders(Response.json(result), rateLimit);
  } catch (error) {
    console.error("Failed to create team:", error);
    await auditUserAction(request, auth.userId, {
      action: "team.created",
      status: 500,
      metadata: { name },
    });
    return applyRateLimitHeaders(
      Response.json({ error: "Internal server error" }, { status: 500 }),
      rateLimit
    );
  }
}
