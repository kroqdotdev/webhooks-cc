import { authenticateSessionRequest } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import { listUserShares } from "@/lib/supabase/request-shares";

/** All of the user's live share links, for the account page. */
export async function GET(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  try {
    return Response.json(await listUserShares(auth.userId));
  } catch (error) {
    reportError("Failed to list share links", error);
    return Response.json({ error: "Failed to list share links" }, { status: 500 });
  }
}
