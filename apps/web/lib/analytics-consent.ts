import posthog from "posthog-js";
import { forgetIdentifiedUser, identifyPendingUser } from "./analytics";
import { cookieValue } from "./cookies";

/**
 * The visitor's analytics choice from the cookie banner, kept by posthog-js in
 * localStorage under this key (a record of the choice, which needs no consent
 * itself). Each site keeps its own, since localStorage is per origin; a
 * switch between the sites carries it over (applyCarriedConsent).
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

/**
 * Do Not Track or Global Privacy Control: posthog-js treats either as a
 * decline (respect_dnt) that a click on Accept cannot override, so the banner
 * says so instead of offering a choice.
 */
export function browserDeclinesTracking(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.doNotTrack === "1" || nav.globalPrivacyControl === true;
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

/**
 * Applies the choice a site switch brought from the other site
 * (consentCarryCookie in lib/site-switch.ts), then clears it. An accept only
 * answers a banner not yet answered here; a decline always applies, so
 * withdrawing on one site withdraws on the other too. Over https only the
 * __Host- cookie counts: a plain one could have been set for the whole
 * domain by another host under it.
 */
export function applyCarriedConsent() {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:";
  const name = secure ? "__Host-whk_consent_carry" : "whk_consent_carry";
  const carried = cookieValue(document.cookie, name);
  if (carried !== "granted" && carried !== "denied") return;
  const here = analyticsConsent();
  if (carried === "denied" && here !== "denied") declineAnalytics();
  if (carried === "granted" && here === "pending" && !browserDeclinesTracking()) {
    acceptAnalytics();
  }
  // A decline storage refused stays carried, for the next page load to retry.
  if (carried === "denied" && analyticsConsent() !== "denied") return;
  document.cookie = secure
    ? `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure`
    : `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

export function openCookieSettings() {
  window.dispatchEvent(new Event(OPEN_COOKIE_SETTINGS_EVENT));
}
