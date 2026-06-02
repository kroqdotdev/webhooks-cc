import { checkRateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/request-validation";
import { pollClaim } from "@/lib/agent/agent-auth";
import { sendError } from "@appsignal/nodejs";

/**
 * Unauthenticated claim poll (auth.md). An agent polls with its one-time
 * `claim_token` to discover whether the in-app claim ceremony has bound its
 * key to a user yet. Returns only coarse status — no credential material.
 */
export async function POST(request: Request) {
  const rateLimited = await checkRateLimit(request, 30);
  if (rateLimited) return rateLimited;

  const parsed = await parseJsonBody(request, 1024);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data as Record<string, unknown>;

  if (typeof body.claim_token !== "string") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // Echo back the caller's registration_id when supplied (pollClaim does not
  // expose it; the agent already holds it from registration).
  const registrationId = typeof body.registration_id === "string" ? body.registration_id : undefined;

  try {
    const result = await pollClaim(body.claim_token);

    switch (result.status) {
      case "pending":
        return Response.json({
          registration_id: registrationId,
          status: "pending",
          // Echo the human-friendly claim code so the agent can re-surface it.
          user_code: result.user_code ?? undefined,
        });
      case "claimed":
        return Response.json({ registration_id: registrationId, status: "claimed" });
      case "expired":
        return Response.json({ error: "claim_expired" }, { status: 410 });
      case "previously_claimed":
        return Response.json({ error: "previously_claimed" }, { status: 409 });
      case "invalid":
        return Response.json({ error: "invalid_claim_token" }, { status: 400 });
    }
  } catch (err) {
    sendError(err instanceof Error ? err : new Error(String(err)));
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
