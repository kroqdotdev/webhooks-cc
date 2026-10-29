import { authenticateSessionRequest } from "@/lib/api-auth";
import { accessToken, googleConfig, GoogleError } from "@/lib/integrations/google";
import { reportError } from "@/lib/observability";
import { googleRefreshToken } from "@/lib/supabase/google-connections";

/**
 * GET /api/integrations/google/picker?connectionId=: what the Drive Picker
 * needs in the browser to let the person pick a spreadsheet for the app: a
 * short-lived access token of their own connection (drive.file only), the
 * Picker's API key and the project number. Picking a file is what grants
 * the app access to it.
 */
export async function GET(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  const config = googleConfig();
  if (!config?.pickerApiKey || !config.projectNumber) {
    return Response.json(
      { error: "The Drive picker is not set up on this server." },
      { status: 503 }
    );
  }
  const connectionId = new URL(request.url).searchParams.get("connectionId") ?? "";
  try {
    const refreshToken = await googleRefreshToken(auth.userId, connectionId);
    if (!refreshToken) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(
      {
        accessToken: await accessToken(config, refreshToken),
        apiKey: config.pickerApiKey,
        appId: config.projectNumber,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof GoogleError)
      return Response.json({ error: error.message }, { status: 502 });
    reportError("Failed to get a picker token", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
