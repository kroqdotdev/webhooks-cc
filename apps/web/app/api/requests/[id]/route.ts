import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { getRequestByIdForUser, withEmailExtracts } from "@/lib/supabase/requests";
import { reportError } from "@/lib/observability";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { id } = await params;

  try {
    const data = await getRequestByIdForUser(auth.userId, id);
    if (!data) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const [withExtracts] = await withEmailExtracts([data]);
    return Response.json(withExtracts);
  } catch (error) {
    reportError("Failed to get request", error);
    return Response.json({ error: "Failed to get request" }, { status: 500 });
  }
}
