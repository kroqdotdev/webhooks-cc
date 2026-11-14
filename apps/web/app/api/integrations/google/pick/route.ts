import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { requestApproval } from "@/lib/approvals/request";
import { googleConfig, isPickNonce, pickerUrl } from "@/lib/integrations/google";
import { reportError } from "@/lib/observability";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/request-validation";
import { SITE_HEADER, parseSite } from "@/lib/site";
import { listGoogleConnections } from "@/lib/supabase/google-connections";

/**
 * POST /api/integrations/google/pick {connectionId, nonce}: the URL of
 * Google's Drive picker for spreadsheets, for the dashboard to open in a
 * pop-up (lib/integrations/google.ts, pickerUrl). The picked file comes back
 * to the picked page of this site with the nonce. With an API key or agent
 * token it is an approval instead (`google.pick`): the owner picks on the
 * approval page, and the asker reads the chosen spreadsheet.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const rateLimit = await checkRateLimitWithInfo(request, "google-pick", 30);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  const config = googleConfig();
  if (!config) return reply({ error: "Google Sheets is not set up on this server." }, 503);
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) return parsed.error;
  const body = (parsed.data ?? {}) as { connectionId?: unknown; nonce?: unknown };
  // An API key or agent token: the owner picks on the approval page, which
  // opens the picker, and the asker reads the chosen spreadsheet.
  if (auth.keyId) {
    return applyRateLimitHeaders(
      await requestApproval(
        request,
        { userId: auth.userId, keyId: auth.keyId, agentRegistrationId: auth.agentRegistrationId },
        "google.pick",
        { connectionId: body.connectionId }
      ),
      rateLimit
    );
  }
  if (!isPickNonce(body.nonce)) return reply({ error: "nonce is invalid" }, 400);
  try {
    const connection = (await listGoogleConnections(auth.userId)).find(
      (candidate) => candidate.id === body.connectionId
    );
    if (!connection) return reply({ error: "not_found" }, 404);
    const site = parseSite(request.headers.get(SITE_HEADER));
    return reply({ url: pickerUrl(config, site, body.nonce, connection.email) });
  } catch (error) {
    reportError("Failed to start a Drive pick", error);
    return reply({ error: "Internal server error" }, 500);
  }
}
