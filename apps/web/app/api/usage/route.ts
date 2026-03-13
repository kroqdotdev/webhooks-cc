import { authenticateRequest } from "@/lib/api-auth";
import { getUsageForUser } from "@/lib/supabase/usage";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  try {
    const usage = await getUsageForUser(auth.userId);
    if (!usage) {
      return Response.json({ error: "Usage not found" }, { status: 404 });
    }

    return Response.json(usage);
  } catch (error) {
    console.error("Failed to fetch usage:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
