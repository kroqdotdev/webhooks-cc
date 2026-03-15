import { authenticateSessionRequest } from "@/lib/api-auth";
import { deleteAccountForUser } from "@/lib/supabase/account";

export async function DELETE(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  try {
    await deleteAccountForUser(auth.userId);
    return Response.json({ success: true });
  } catch (error) {
    console.error("Account deletion failed:", error);
    return Response.json({ error: "Failed to delete account" }, { status: 500 });
  }
}
