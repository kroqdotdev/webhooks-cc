import { authenticateSessionRequest } from "@/lib/api-auth";
import { listConnectedAgents } from "@/lib/agent/claims";
import { reportError } from "@/lib/observability";

/** GET /api/agent/registrations: the account's connected agents. Session only. */
export async function GET(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  try {
    return Response.json(await listConnectedAgents(auth.userId));
  } catch (error) {
    reportError("GET /api/agent/registrations failed", error);
    return Response.json({ error: "Failed to list connected agents" }, { status: 500 });
  }
}
