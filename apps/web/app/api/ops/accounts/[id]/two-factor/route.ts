import { auditUserAction } from "@/lib/audit";
import { notifyTwoFactorOff, removeTwoFactor } from "@/lib/mfa-recovery";
import { reportError } from "@/lib/observability";
import { authenticateStaffRequest, isStaff, opsJson } from "@/lib/staff";
import { isUuid } from "@/lib/uuid";

/**
 * Turns off someone's two-factor sign-in when they lost their authenticator
 * and their recovery codes and proved who they are another way. The owner
 * is emailed.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const { id } = await params;
  if (!isUuid(id)) return opsJson({ error: "Not found" }, { status: 404 });
  try {
    // Never for a staff account, the caller's own included: staff accounts
    // reach every customer's data, so one staff session cannot strip
    // another's second factor. Staff manage their own under Account,
    // Security; a lost staff authenticator is fixed in the database.
    if (id === auth.userId || (await isStaff(id))) {
      return opsJson(
        { error: "Two-factor sign-in of a staff account cannot be turned off here." },
        { status: 403 }
      );
    }
    const removed = await removeTwoFactor(id);
    await auditUserAction(request, auth.userId, {
      action: "ops.mfa_reset",
      status: 200,
      targetUserId: id,
      metadata: { factors: removed },
    });
    if (removed > 0) await notifyTwoFactorOff(id, "support");
    return opsJson({ removed });
  } catch (error) {
    reportError("[ops] removing two-factor failed", error);
    return opsJson({ error: "Two-factor sign-in could not be turned off." }, { status: 500 });
  }
}
