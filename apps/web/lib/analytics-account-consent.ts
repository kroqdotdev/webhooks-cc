import {
  acceptAnalytics,
  analyticsConsent,
  browserDeclinesTracking,
  declineAnalytics,
} from "./analytics-consent";

/**
 * The analytics choice follows a signed-in account to its other browsers.
 * The account keeps the last choice made while signed in
 * (/api/account/analytics-consent); on a signed-in page load it answers this
 * browser the way a site switch does: a decline always applies, so
 * withdrawing anywhere withdraws everywhere, and an accept only answers a
 * banner not yet answered here. Do Not Track and Global Privacy Control
 * still win over an accept.
 */

const ROUTE = "/api/account/analytics-consent";
const TIMEOUT_MS = 5_000;

/**
 * Set when the banner is answered in this tab, so a choice made just before
 * signing in (the banner shows on the sign-in page of a new browser) can be
 * saved to the account. An accept from an earlier visit is not: it may have
 * been someone else's on a shared computer, and an accept saved on the
 * account answers that person's other browsers. A decline is always saved.
 */
const ANSWERED_HERE_KEY = "whk_consent_answered_here";

let syncedUserId: string | null = null;
let inFlight: Promise<void> | null = null;

export function markConsentAnsweredHere() {
  try {
    sessionStorage.setItem(ANSWERED_HERE_KEY, "1");
  } catch {
    // Storage refused: the choice just stays in this browser.
  }
}

function answeredHere(): boolean {
  try {
    return sessionStorage.getItem(ANSWERED_HERE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Saves a choice on the account. Best effort: the browser keeps its own copy either way. */
export async function saveAccountConsent(
  accessToken: string,
  consent: "granted" | "denied"
): Promise<void> {
  try {
    await fetch(ROUTE, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ consent }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Offline or slow: the next signed-in page load saves it again.
  }
}

async function readAccountConsent(accessToken: string): Promise<"granted" | "denied" | null> {
  const response = await fetch(ROUTE, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`analytics consent read: ${response.status}`);
  const body = (await response.json()) as { consent?: unknown };
  return body.consent === "granted" || body.consent === "denied" ? body.consent : null;
}

async function sync(accessToken: string): Promise<void> {
  const saved = await readAccountConsent(accessToken);
  const here = analyticsConsent();
  if (saved === "denied") {
    if (here !== "denied") declineAnalytics();
    return;
  }
  if (saved === "granted") {
    if (here === "pending" && !browserDeclinesTracking()) acceptAnalytics();
    return;
  }
  // Nothing saved yet: the account takes this browser's answer.
  if (here === "denied" || (here === "granted" && answeredHere())) {
    await saveAccountConsent(accessToken, here);
  }
}

/**
 * Answers this browser from the account once per signed-in user and page
 * load. Resolves when done, failed or timed out, so the banner can wait for it
 * instead of flashing up and away.
 */
export function syncAccountConsent(userId: string, accessToken: string): Promise<void> {
  if (syncedUserId === userId && inFlight) return inFlight;
  syncedUserId = userId;
  inFlight = sync(accessToken).catch(() => {
    // Unreachable or refused: this browser keeps asking for itself, and a
    // later page load tries again.
  });
  return inFlight;
}

/** For tests. */
export function resetAccountConsentSync() {
  syncedUserId = null;
  inFlight = null;
}
