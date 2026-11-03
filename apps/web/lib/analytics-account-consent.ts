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

type Consent = "granted" | "denied";

const ROUTE = "/api/account/analytics-consent";
const TIMEOUT_MS = 5_000;

/**
 * Set when the banner is answered in this tab, so a choice made just before
 * signing in (the banner shows on the sign-in page of a new browser) can be
 * saved to the account. An accept from an earlier visit is not: it may have
 * been someone else's on a shared computer, and an accept saved on the
 * account answers that person's other browsers. A decline is always saved.
 * Cleared when a signed-in session ends.
 */
const ANSWERED_HERE_KEY = "whk_consent_answered_here";

/**
 * A choice made here that has not reached the account yet (offline, a failed
 * save), kept until it does: the next signed-in page load sends it again
 * unless the account holds a newer one. Named by the account it was for.
 */
const UNSAVED_KEY = "whk_consent_unsaved";

interface Unsaved {
  userId: string;
  consent: Consent;
  at: number;
}

let syncedUserId: string | null = null;
let inFlight: Promise<void> | null = null;
/** Bumped when a session ends or changes: a read still pending then is stale. */
let generation = 0;
/** Bumped on every click in the banner: an account read pending then is stale. */
let explicitAnswers = 0;
/** Saves leave one at a time, in the order they were made. */
let saveQueue: Promise<unknown> = Promise.resolve();

export function markConsentAnsweredHere() {
  explicitAnswers += 1;
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

/**
 * Called when a signed-in session ends or changes to another account: a
 * pending account read no longer applies, and an accept given in this tab was
 * the former account's.
 */
export function endAccountConsentSession() {
  generation += 1;
  syncedUserId = null;
  inFlight = null;
  try {
    sessionStorage.removeItem(ANSWERED_HERE_KEY);
  } catch {
    // Storage refused: nothing was stored.
  }
}

function readUnsaved(userId: string): Unsaved | null {
  try {
    const raw = localStorage.getItem(UNSAVED_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Unsaved>;
    if (
      value.userId !== userId ||
      (value.consent !== "granted" && value.consent !== "denied") ||
      typeof value.at !== "number"
    ) {
      return null;
    }
    return value as Unsaved;
  } catch {
    return null;
  }
}

function writeUnsaved(value: Unsaved) {
  try {
    localStorage.setItem(UNSAVED_KEY, JSON.stringify(value));
  } catch {
    // Storage refused: a failed save is then only retried by a new click.
  }
}

/** Clears the unsaved choice if it is still the one given (a later one stays). */
function clearUnsaved(value: Unsaved) {
  try {
    const raw = localStorage.getItem(UNSAVED_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as Partial<Unsaved>;
    if (stored.userId === value.userId && stored.at === value.at) {
      localStorage.removeItem(UNSAVED_KEY);
    }
  } catch {
    // Storage refused
  }
}

async function put(accessToken: string, value: Unsaved): Promise<boolean> {
  try {
    const response = await fetch(ROUTE, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ consent: value.consent }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return false;
    clearUnsaved(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Saves a choice on the account, after any save still on its way, so a
 * later click always lands last. The choice is kept in this browser at once,
 * before the token is fetched or the request leaves, and only cleared once the
 * account has it: one that never arrives (offline, no token, the page closed)
 * is sent again on the next signed-in page load. Resolves to whether the
 * account has it.
 */
export function saveAccountConsent(
  userId: string,
  accessToken: string | (() => Promise<string | null>),
  consent: Consent,
  at: number = Date.now()
): Promise<boolean> {
  const value: Unsaved = { userId, consent, at };
  writeUnsaved(value);
  const run = saveQueue.then(async () => {
    const token = typeof accessToken === "string" ? accessToken : await accessToken();
    return token ? put(token, value) : false;
  });
  saveQueue = run.catch(() => false);
  return run;
}

async function readAccountConsent(accessToken: string): Promise<{
  consent: Consent | null;
  savedAt: number | null;
  /** Our clock minus this browser's, to compare a time noted here with savedAt. */
  offset: number;
}> {
  const response = await fetch(ROUTE, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`analytics consent read: ${response.status}`);
  const receivedAt = Date.now();
  const body = (await response.json()) as { consent?: unknown; savedAt?: unknown; now?: unknown };
  const consent = body.consent === "granted" || body.consent === "denied" ? body.consent : null;
  const savedAt = typeof body.savedAt === "string" ? Date.parse(body.savedAt) : NaN;
  const now = typeof body.now === "string" ? Date.parse(body.now) : NaN;
  return {
    consent,
    savedAt: Number.isNaN(savedAt) ? null : savedAt,
    offset: Number.isNaN(now) ? 0 : now - receivedAt,
  };
}

async function sync(userId: string, accessToken: string, started: number): Promise<void> {
  const answersBefore = explicitAnswers;
  const account = await readAccountConsent(accessToken);
  // The session ended or changed, or the visitor answered, while it was read.
  if (started !== generation || answersBefore !== explicitAnswers) return;

  // A choice made here that never reached the account goes first, unless the
  // account has been given a newer one since.
  const unsaved = readUnsaved(userId);
  if (unsaved) {
    if (account.savedAt === null || account.savedAt < unsaved.at + account.offset) {
      await saveAccountConsent(userId, accessToken, unsaved.consent, unsaved.at);
      return;
    }
    clearUnsaved(unsaved);
  }

  const here = analyticsConsent();
  if (account.consent === "denied") {
    if (here !== "denied") declineAnalytics();
    return;
  }
  if (account.consent === "granted") {
    if (here === "pending" && !browserDeclinesTracking()) acceptAnalytics();
    return;
  }
  // Nothing saved yet: the account takes this browser's answer, but never a
  // decline that only Do Not Track or Global Privacy Control made, which
  // belongs to this browser alone.
  if (browserDeclinesTracking()) return;
  if (here === "denied" || (here === "granted" && answeredHere())) {
    await saveAccountConsent(userId, accessToken, here);
  }
}

/**
 * Answers this browser from the account once per signed-in user and page
 * load. Resolves when done, failed or timed out, so the banner can wait for it
 * instead of flashing up and away.
 */
export function syncAccountConsent(userId: string, accessToken: string): Promise<void> {
  if (syncedUserId === userId && inFlight) return inFlight;
  if (syncedUserId !== null && syncedUserId !== userId) generation += 1;
  syncedUserId = userId;
  inFlight = sync(userId, accessToken, generation).catch(() => {
    // Unreachable or refused: this browser keeps asking for itself, and a
    // later page load tries again.
  });
  return inFlight;
}

/** For tests. */
export function resetAccountConsentSync() {
  syncedUserId = null;
  inFlight = null;
  generation += 1;
  explicitAnswers = 0;
  saveQueue = Promise.resolve();
}
