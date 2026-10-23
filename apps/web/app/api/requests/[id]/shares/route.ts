import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import { checkRateLimitByKey } from "@/lib/rate-limit";
import { MAX_ACTIVE_SHARES, SHARE_EXPIRY_DAYS, type ShareExpiryDays } from "@/lib/request-share";
import { createRequestShare, listRequestShares } from "@/lib/supabase/request-shares";
import { isUuid } from "@/lib/uuid";

// Share links publish a request to anyone holding the link, so they take a
// signed-in session, never an API key.

const SHARE_ERRORS = {
  not_found: { status: 404, message: "not_found" },
  email: { status: 400, message: "Emails cannot be shared" },
  not_owner: { status: 403, message: "Only the endpoint's owner can share its requests" },
  limit: {
    status: 409,
    message: `You can have ${MAX_ACTIVE_SHARES} live share links. Revoke some first.`,
  },
} as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { id } = await params;
  if (!isUuid(id)) return Response.json([]);

  try {
    return Response.json(await listRequestShares(auth.userId, id));
  } catch (error) {
    reportError("Failed to list request shares", error);
    return Response.json({ error: "Failed to list share links" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const limited = await checkRateLimitByKey(`request-share:${auth.userId}`, 20, 60_000);
  if (limited) return limited;

  const { id } = await params;
  let body: { expiresInDays?: unknown; hideSensitive?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  const expiresInDays = body.expiresInDays as ShareExpiryDays;
  if (!SHARE_EXPIRY_DAYS.includes(expiresInDays)) {
    return Response.json(
      { error: `expiresInDays must be one of ${SHARE_EXPIRY_DAYS.join(", ")}` },
      { status: 400 }
    );
  }
  const hideSensitive = body.hideSensitive !== false;

  if (!isUuid(id)) return Response.json({ error: "not_found" }, { status: 404 });

  try {
    const result = await createRequestShare({
      userId: auth.userId,
      requestId: id,
      expiresInDays,
      hideSensitive,
    });
    if (!result.ok) {
      const { status, message } = SHARE_ERRORS[result.error];
      await auditUserAction(request, auth.userId, {
        action: "request.share_created",
        status,
        targetId: id,
        reason: result.error,
      });
      return Response.json({ error: message }, { status });
    }

    await auditUserAction(request, auth.userId, {
      action: "request.share_created",
      status: 200,
      targetId: result.share.id,
      metadata: {
        requestId: id,
        endpointId: result.endpointId,
        expiresInDays,
        hideSensitive,
        redactedHeaders: result.share.redactedHeaders.length,
      },
    });
    return Response.json(result.share);
  } catch (error) {
    reportError("Failed to create request share", error);
    await auditUserAction(request, auth.userId, {
      action: "request.share_created",
      status: 500,
      targetId: id,
    });
    return Response.json({ error: "Failed to create share link" }, { status: 500 });
  }
}
