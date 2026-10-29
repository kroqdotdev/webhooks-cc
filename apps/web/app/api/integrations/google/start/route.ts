import { authenticateSessionRequest } from "@/lib/api-auth";
import {
  authorizationUrl,
  browserCookie,
  googleConfig,
  safeReturnPath,
  sealBeginTicket,
} from "@/lib/integrations/google";
import { parseJsonBody } from "@/lib/request-validation";
import { SITE_HEADER, parseSite, webhooksOrigin } from "@/lib/site";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";

/**
 * POST /api/integrations/google/start {returnTo}: the Google consent URL to
 * send the browser to, for connecting a Google account to Sheets
 * destinations. A session, not an API key: connecting grants access to the
 * person's Google Drive files.
 */
export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  const rateLimit = await checkRateLimitWithInfo(request, "google-connect", 20);
  if (rateLimit.response) return rateLimit.response;
  const reply = (body: unknown, status = 200) =>
    applyRateLimitHeaders(Response.json(body, { status }), rateLimit);

  const config = googleConfig();
  if (!config) return reply({ error: "Google Sheets is not set up on this server." }, 503);
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) return parsed.error;
  const body = (parsed.data ?? {}) as { returnTo?: unknown };
  const site = parseSite(request.headers.get(SITE_HEADER));
  const { url, browserNonce } = authorizationUrl(
    config,
    auth.userId,
    safeReturnPath(body.returnTo),
    site
  );
  if (site === "mailhooks") {
    // The callback is webhooks.cc's: the cookie must be set there first.
    const ticket = sealBeginTicket(url, browserNonce);
    return reply({
      url: `${webhooksOrigin()}/api/integrations/google/begin?ticket=${encodeURIComponent(ticket)}`,
    });
  }
  const response = reply({ url });
  // Only this browser can finish the flow (see OAuthState.browser).
  response.headers.append(
    "set-cookie",
    browserCookie(browserNonce, new URL(request.url).protocol === "https:")
  );
  return response;
}
