import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { loggablePolarError } from "@/lib/polar";
import { applyRateLimitHeaders, checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { AccountDeletionBillingError, deleteAccountForUser } from "@/lib/supabase/account";
import { parseDisplayName, updateDisplayName } from "@/lib/supabase/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

const NAME_REQUIRED = "name is required (a string, or null to clear it)";
// A field left out stays out of the parsed body, so `"name" in` still tells
// "clear it" (null) from "not sent".
const patchBody = z.object({
  name: z.unknown().optional(),
  approvalEmails: z.unknown().optional(),
});

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

  const read = await parseJsonBodyWith(request, patchBody, {
    message: NAME_REQUIRED,
    invalidJson: "Invalid JSON body",
  });
  if ("error" in read) return applyRateLimitHeaders(read.error, rateLimit);

  if ("approvalEmails" in read.data) {
    return setApprovalEmails(request, auth.userId, read.data.approvalEmails, rateLimit);
  }
  if (!("name" in read.data)) {
    return applyRateLimitHeaders(Response.json({ error: NAME_REQUIRED }, { status: 400 }), rateLimit);
  }

  const parsed = parseDisplayName(read.data.name);
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

/** The opt-in email for every approval asked for on the account (lib/approvals). */
async function setApprovalEmails(
  request: Request,
  userId: string,
  value: unknown,
  rateLimit: Parameters<typeof applyRateLimitHeaders>[1]
): Promise<Response> {
  if (typeof value !== "boolean") {
    return applyRateLimitHeaders(
      Response.json({ error: "approvalEmails must be true or false" }, { status: 400 }),
      rateLimit
    );
  }
  const { error } = await createAdminClient()
    .from("users")
    .update({ approval_emails: value })
    .eq("id", userId);
  if (error) {
    reportError("PATCH /api/account approvalEmails failed", error);
    return applyRateLimitHeaders(
      Response.json({ error: "Could not save that" }, { status: 500 }),
      rateLimit
    );
  }
  await auditUserAction(request, userId, {
    action: "account.approval_emails_updated",
    status: 200,
    metadata: { enabled: value },
  });
  return applyRateLimitHeaders(Response.json({ approvalEmails: value }), rateLimit);
}
