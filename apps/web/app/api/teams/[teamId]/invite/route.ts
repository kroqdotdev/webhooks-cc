import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { checkRateLimitByKeyWithInfo, applyRateLimitHeaders } from "@/lib/rate-limit";
import { createInvite } from "@/lib/supabase/teams";

const INVITE_RATE_LIMIT_MAX = 20;
const INVITE_RATE_LIMIT_WINDOW_MS = 10 * 60_000;

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const rateLimit = await checkRateLimitByKeyWithInfo(
    `team-invite:${auth.userId}`,
    INVITE_RATE_LIMIT_MAX,
    INVITE_RATE_LIMIT_WINDOW_MS
  );
  if (rateLimit.response) return rateLimit.response;

  const { teamId } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !email.includes("@")) {
    return Response.json({ error: "Valid email is required" }, { status: 400 });
  }

  try {
    const result = await createInvite(auth.userId, teamId, email);
    await auditUserAction(request, auth.userId, {
      action: "team.invite_sent",
      status: result.error ? 400 : 200,
      reason: result.error,
      teamId,
      targetId: result.invite?.id ?? null,
      metadata: { invited_email: email.toLowerCase() },
    });
    if (result.error) {
      return applyRateLimitHeaders(
        Response.json({ error: result.error }, { status: 400 }),
        rateLimit
      );
    }
    return applyRateLimitHeaders(
      Response.json({ ...result.invite, warning: result.warning }),
      rateLimit
    );
  } catch (error) {
    console.error("Failed to create invite:", error);
    await auditUserAction(request, auth.userId, {
      action: "team.invite_sent",
      status: 500,
      teamId,
      metadata: { invited_email: email.toLowerCase() },
    });
    return applyRateLimitHeaders(
      Response.json({ error: "Internal server error" }, { status: 500 }),
      rateLimit
    );
  }
}
