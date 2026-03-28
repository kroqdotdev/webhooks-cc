import { authenticateRequest } from "@/lib/api-auth";
import { checkRateLimitByKey } from "@/lib/rate-limit";
import { createInvite } from "@/lib/supabase/teams";

const INVITE_RATE_LIMIT_MAX = 20;
const INVITE_RATE_LIMIT_WINDOW_MS = 10 * 60_000;

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const rateLimited = checkRateLimitByKey(
    `team-invite:${auth.userId}`,
    INVITE_RATE_LIMIT_MAX,
    INVITE_RATE_LIMIT_WINDOW_MS
  );
  if (rateLimited) return rateLimited;

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
    if (result.error) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    return Response.json(result.invite);
  } catch (error) {
    console.error("Failed to create invite:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
