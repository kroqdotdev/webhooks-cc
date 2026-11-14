import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { requestApproval } from "@/lib/approvals/request";
import {
  authorizationUrl,
  browserCookie,
  googleConfig,
  handoffCookie,
  handoffHash,
  safeReturnPath,
  sealBeginTicket,
} from "@/lib/integrations/google";
import { randomBase64Url } from "@/lib/ids";
import { parseJsonBody } from "@/lib/request-validation";
import { SITE_HEADER, parseSite, webhooksOrigin } from "@/lib/site";
import { applyRateLimitHeaders, checkRateLimitWithInfo } from "@/lib/rate-limit";

/**
 * POST /api/integrations/google/start {returnTo}: the Google consent URL to
 * send the browser to, for connecting a Google account to Sheets
 * destinations. Connecting grants access to the person's Google Drive
 * files, so an API key or agent token gets an approval instead
 * (`google.connect`): approving it sends the owner's browser to Google.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  if (auth.keyId) {
    return requestApproval(
      request,
      { userId: auth.userId, keyId: auth.keyId, agentRegistrationId: auth.agentRegistrationId },
      "google.connect",
      {}
    );
  }
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
  // Started on mailhooks.cc: this browser proves itself there on the way out
  // (handoff) and on the way back (finish) with this cookie.
  const handoff = site === "mailhooks" ? randomBase64Url(24) : null;
  const { url, browserNonce } = authorizationUrl(
    config,
    auth.userId,
    safeReturnPath(body.returnTo),
    site,
    handoff ? handoffHash(handoff) : undefined
  );
  if (handoff) {
    // The callback is webhooks.cc's: its cookie is set there on the way.
    const ticket = sealBeginTicket(url, browserNonce, handoffHash(handoff));
    const response = reply({
      url: `${webhooksOrigin()}/api/integrations/google/begin?ticket=${encodeURIComponent(ticket)}`,
    });
    response.headers.append(
      "set-cookie",
      handoffCookie(handoff, new URL(request.url).protocol === "https:")
    );
    return response;
  }
  const response = reply({ url });
  // Only this browser can finish the flow (see OAuthState.browser).
  response.headers.append(
    "set-cookie",
    browserCookie(browserNonce, new URL(request.url).protocol === "https:")
  );
  return response;
}
