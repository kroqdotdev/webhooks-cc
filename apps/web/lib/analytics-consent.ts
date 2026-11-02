import posthog from "posthog-js";
import { forgetIdentifiedUser, identifyPendingUser } from "./analytics";

/**
 * The visitor's analytics choice from the cookie banner, kept by posthog-js in
 * localStorage under this key (a record of the choice, which needs no consent
 * itself). Each site keeps its own, since localStorage is per origin.
 */
export const ANALYTICS_CONSENT_KEY = "whk_analytics_consent";

/** Fired to open the banner again from a "Cookie settings" link. */
export const OPEN_COOKIE_SETTINGS_EVENT = "whk:cookie-settings";

export type AnalyticsConsent = "granted" | "denied" | "pending";

export function analyticsConsent(): AnalyticsConsent {
  try {
    return posthog.get_explicit_consent_status();
  } catch {
    return "pending";
  }
}

/** Accept: posthog-js may now store its identifier, and a signed-in user is identified. */
export function acceptAnalytics() {
  try {
    posthog.opt_in_capturing();
    identifyPendingUser();
  } catch {
    // PostHog not initialized
  }
}

/** Decline (or withdraw): back to cookieless counting, and stored identifiers are removed. */
export function declineAnalytics() {
  try {
    posthog.opt_out_capturing();
    forgetIdentifiedUser();
  } catch {
    // PostHog not initialized
  }
}

export function openCookieSettings() {
  window.dispatchEvent(new Event(OPEN_COOKIE_SETTINGS_EVENT));
}
