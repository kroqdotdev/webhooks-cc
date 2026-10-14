import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { loggablePolarError } from "@/lib/polar";
import { applyRateLimitHeaders, checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { AccountDeletionBillingError, deleteAccountForUser } from "@/lib/supabase/account";
import { parseDisplayName, updateDisplayName } from "@/lib/supabase/profile";
import { reportError } from "@/lib/observability";

const NAME_RATE_LIMIT_MAX = 20;
const NAME_RATE_LIMIT_WINDOW_MS = 10 * 60_000;

/**
 * Sets or clears the display name. Session-only, like every account change:
 * connected agents are promised they cannot change the account, and their
 * tokens are API keys.
 */
export async function PATCH(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const rateLimit = await checkRateLimitByKeyWithInfo(
    `account-name:${auth.userId}`,
    NAME_RATE_LIMIT_MAX,
    NAME_RATE_LIMIT_WINDOW_MS
  );
  if (rateLimit.response) return rateLimit.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return applyRateLimitHeaders(
      Response.json({ error: "Invalid JSON body" }, { status: 400 }),
      rateLimit
    );
  }

  if (!body || typeof body !== "object" || Array.isArray(body) || !("name" in body)) {
    return applyRateLimitHeaders(
      Response.json({ error: "name is required (a string, or null to clear it)" }, { status: 400 }),
      rateLimit
    );
  }

  const parsed = parseDisplayName((body as { name: unknown }).name);
  if (!parsed.ok) {
    await auditUserAction(request, auth.userId, {
      action: "account.name_updated",
      status: 400,
      reason: parsed.error,
    });
    return applyRateLimitHeaders(
      Response.json({ error: parsed.error }, { status: 400 }),
      rateLimit
    );
  }

  try {
    const name = await updateDisplayName(auth.userId, parsed.value);
    await auditUserAction(request, auth.userId, {
      action: "account.name_updated",
      status: 200,
      metadata: { cleared: parsed.value === null },
    });
    return applyRateLimitHeaders(Response.json({ name }), rateLimit);
  } catch (error) {
    reportError("Display name update failed", error);
    await auditUserAction(request, auth.userId, { action: "account.name_updated", status: 500 });
    return applyRateLimitHeaders(
      Response.json({ error: "Failed to update name" }, { status: 500 }),
      rateLimit
    );
  }
}

export async function DELETE(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  try {
    await deleteAccountForUser(auth.userId);
    await auditUserAction(request, auth.userId, { action: "account.deleted", status: 200 });
    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof AccountDeletionBillingError) {
      reportError("Account deletion blocked by billing", loggablePolarError(error.cause));
      await auditUserAction(request, auth.userId, {
        action: "account.deleted",
        status: 409,
        metadata: { code: error.code },
      });
      return Response.json(
        {
          error:
            "We could not cancel your subscription, so the account was not deleted. Try again in a moment, or cancel the subscription from the billing section first.",
          code: error.code,
        },
        { status: 409 }
      );
    }
    reportError("Account deletion failed", error);
    await auditUserAction(request, auth.userId, { action: "account.deleted", status: 500 });
    return Response.json({ error: "Failed to delete account" }, { status: 500 });
  }
}
