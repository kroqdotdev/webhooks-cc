import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import { applyRateLimitHeaders, checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import {
  getAccountAnalyticsConsent,
  parseAccountAnalyticsConsent,
  setAccountAnalyticsConsent,
} from "@/lib/supabase/analytics-consent";

// Read on every page load of a signed-in browser, so the read limit is loose.
const READ_RATE_LIMIT_MAX = 300;
const WRITE_RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;

/**
 * The analytics choice saved on the account, which answers the cookie banner
 * in the account's other browsers (lib/analytics-account-consent.ts).
 * Session-only: the choice is the person's, never an agent's.
 */
export async function GET(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const rateLimit = await checkRateLimitByKeyWithInfo(
    `analytics-consent-read:${auth.userId}`,
    READ_RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS
  );
  if (rateLimit.response) return rateLimit.response;

  try {
    const { consent, savedAt } = await getAccountAnalyticsConsent(auth.userId);
    return applyRateLimitHeaders(
      Response.json({ consent, savedAt }, { headers: { "Cache-Control": "no-store" } }),
      rateLimit
    );
  } catch (error) {
    reportError("Analytics consent read failed", error);
    return applyRateLimitHeaders(
      Response.json({ error: "Failed to read the analytics choice" }, { status: 500 }),
      rateLimit
    );
  }
}

/** Saves `{ consent: "granted" | "denied" }` on the account. */
export async function PUT(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const rateLimit = await checkRateLimitByKeyWithInfo(
    `analytics-consent-write:${auth.userId}`,
    WRITE_RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS
  );
  if (rateLimit.response) return rateLimit.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return applyRateLimitHeaders(
      Response.json({ error: "Invalid JSON body" }, { status: 400 }),
      rateLimit
    );
  }

  const consent =
    body && typeof body === "object" && !Array.isArray(body)
      ? parseAccountAnalyticsConsent((body as { consent?: unknown }).consent)
      : null;
  if (!consent) {
    return applyRateLimitHeaders(
      Response.json({ error: 'consent must be "granted" or "denied"' }, { status: 400 }),
      rateLimit
    );
  }

  try {
    const changed = await setAccountAnalyticsConsent(auth.userId, consent);
    if (changed) {
      await auditUserAction(request, auth.userId, {
        action: "account.analytics_consent_updated",
        status: 200,
        metadata: { consent },
      });
    }
    return applyRateLimitHeaders(Response.json({ consent }), rateLimit);
  } catch (error) {
    reportError("Analytics consent update failed", error);
    await auditUserAction(request, auth.userId, {
      action: "account.analytics_consent_updated",
      status: 500,
    });
    return applyRateLimitHeaders(
      Response.json({ error: "Failed to save the analytics choice" }, { status: 500 }),
      rateLimit
    );
  }
}
