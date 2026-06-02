import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { getRequestByIdForUser } from "@/lib/supabase/requests";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { id } = await params;

  try {
    const data = await getRequestByIdForUser(auth.userId, id);
    if (!data) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return Response.json(data);
  } catch (error) {
    console.error("Failed to get request:", error);
    return Response.json({ error: "Failed to get request" }, { status: 500 });
  }
}
