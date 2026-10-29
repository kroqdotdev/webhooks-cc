import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { googleConfig } from "@/lib/integrations/google";
import { reportError } from "@/lib/observability";
import { listGoogleConnections } from "@/lib/supabase/google-connections";

/** GET /api/integrations/google/connections: your connected Google accounts. */
export async function GET(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  try {
    const config = googleConfig();
    return Response.json({
      available: config !== null,
      picker: !!config?.pickerApiKey && !!config.projectNumber,
      connections: await listGoogleConnections(auth.userId),
    });
  } catch (error) {
    reportError("Failed to list Google connections", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
