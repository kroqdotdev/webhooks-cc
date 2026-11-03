import { authenticateSessionRequest, extractBearerToken } from "@/lib/api-auth";
import { passedSecondFactor } from "@/lib/mfa-session";
import { sanitizeNextPath } from "@/lib/auth-redirect";
import { parseJsonBody } from "@/lib/request-validation";
import { checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import {
  GRANT_LIFETIME_MS,
  parseCarriedConsent,
  sealGrant,
  switchKeyConfigured,
} from "@/lib/site-switch";
import { SITE_HEADER, otherSite, parseSite, siteOrigin, twoSites } from "@/lib/site";

/** Grants per account per minute: a person clicks a few; a script would ask for many. */
const GRANTS_PER_MINUTE = 10;

/**
 * POST /api/site-switch { next, consent? }: the first stop of carrying the session to
 * the other site (lib/site-switch.ts). A browser session only, never an API
 * key: the signed-in page asks with its own bearer token, which a page on
 * another site cannot send. Answers { url }, the other site's
 * /auth/switch/start with a grant for this account, carrying the page's
 * cookie banner answer when it had one.
 */
export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  if (!twoSites() || !switchKeyConfigured()) {
    return Response.json({ error: "Switching sites is not available here." }, { status: 404 });
  }

  const limit = await checkRateLimitByKeyWithInfo(
    `site-switch-grant:${auth.userId}`,
    GRANTS_PER_MINUTE
  );
  if (limit.response) return limit.response;

  const parsed = await parseJsonBody(request, 4 * 1024);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data as Record<string, unknown>;
  const next = sanitizeNextPath(typeof body.next === "string" ? body.next : null);

  const to = otherSite(parseSite(request.headers.get(SITE_HEADER)));
  const start = new URL("/auth/switch/start", siteOrigin(to));
  start.searchParams.set(
    "g",
    sealGrant({
      userId: auth.userId,
      expires: Date.now() + GRANT_LIFETIME_MS,
      consent: parseCarriedConsent(body.consent),
      secondFactor: await passedSecondFactor({ id: auth.userId }, extractBearerToken(request)!),
    })
  );
  start.searchParams.set("next", next);
  return Response.json({ url: start.toString() }, { headers: { "cache-control": "no-store" } });
}
