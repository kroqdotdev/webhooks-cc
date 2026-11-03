import { auditUserAction } from "@/lib/audit";
import { notifyTwoFactorOff, removeTwoFactor } from "@/lib/mfa-recovery";
import { reportError } from "@/lib/observability";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
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
  if (id === auth.userId) {
    return opsJson(
      { error: "Turn off your own two-factor sign-in under Account, Security." },
      { status: 409 }
    );
  }
  try {
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
