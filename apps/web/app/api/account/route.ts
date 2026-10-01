import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { loggablePolarError } from "@/lib/polar";
import { AccountDeletionBillingError, deleteAccountForUser } from "@/lib/supabase/account";

export async function DELETE(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  try {
    await deleteAccountForUser(auth.userId);
    await auditUserAction(request, auth.userId, { action: "account.deleted", status: 200 });
    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof AccountDeletionBillingError) {
      console.error("Account deletion blocked by billing:", loggablePolarError(error.cause));
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
    console.error("Account deletion failed:", error);
    await auditUserAction(request, auth.userId, { action: "account.deleted", status: 500 });
    return Response.json({ error: "Failed to delete account" }, { status: 500 });
  }
}
