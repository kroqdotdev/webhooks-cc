import { authenticateRequest } from "@/lib/api-auth";
import { checkRateLimitByKeyWithInfo, applyRateLimitHeaders } from "@/lib/rate-limit";
import { shareEndpointWithTeam } from "@/lib/supabase/teams";

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const rateLimit = await checkRateLimitByKeyWithInfo(`team-share:${auth.userId}`, 30, 10 * 60_000);
  if (rateLimit.response) return rateLimit.response;

  const { teamId } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const endpointId = typeof body.endpointId === "string" ? body.endpointId : "";
  if (!endpointId) {
    return Response.json({ error: "endpointId is required" }, { status: 400 });
  }

  try {
    const result = await shareEndpointWithTeam(auth.userId, teamId, endpointId);
    if (!result.success) {
      return applyRateLimitHeaders(
        Response.json({ error: result.error }, { status: 400 }),
        rateLimit
      );
    }
    return applyRateLimitHeaders(Response.json({ success: true }), rateLimit);
  } catch (error) {
    console.error("Failed to share endpoint:", error);
    return applyRateLimitHeaders(
      Response.json({ error: "Internal server error" }, { status: 500 }),
      rateLimit
    );
  }
}
