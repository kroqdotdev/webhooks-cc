import { authenticateSessionRequest } from "@/lib/api-auth";
import { loggablePolarError } from "@/lib/polar";
import { AccountDeletionBillingError, deleteAccountForUser } from "@/lib/supabase/account";

export async function DELETE(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  try {
    await deleteAccountForUser(auth.userId);
    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof AccountDeletionBillingError) {
      console.error("Account deletion blocked by billing:", loggablePolarError(error.cause));
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
    return Response.json({ error: "Failed to delete account" }, { status: 500 });
  }
}
