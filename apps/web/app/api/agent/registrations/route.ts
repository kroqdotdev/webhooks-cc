import { sendError } from "@appsignal/nodejs";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { listConnectedAgents } from "@/lib/agent/claims";

/** GET /api/agent/registrations: the account's connected agents. Session only. */
export async function GET(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  try {
    return Response.json(await listConnectedAgents(auth.userId));
  } catch (error) {
    sendError(error instanceof Error ? error : new Error(String(error)));
    return Response.json({ error: "Failed to list connected agents" }, { status: 500 });
  }
}
