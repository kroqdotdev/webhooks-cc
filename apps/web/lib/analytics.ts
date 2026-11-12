import posthog from "posthog-js";

/**
 * Track custom analytics events via PostHog.
 * All calls are safe to make even if PostHog is not initialized: they no-op.
 */

function capture(event: string, properties?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    posthog.capture(event, properties);
  } catch {
    // PostHog not initialized: silently ignore
  }
}

// ── Landing page ────────────────────────────────────────────────
export function trackCTAClick(
  cta: "register" | "try_live" | "docs" | "faq" | "create_team" | "layout_gallery"
) {
  capture("landing_cta_clicked", { cta });
}

// ── Auth ────────────────────────────────────────────────────────
export function trackSignInStarted(provider: "github" | "google" | "email") {
  capture("sign_in_started", { provider });
}

// ── Dashboard ───────────────────────────────────────────────────
export function trackEndpointCreated() {
  capture("endpoint_created");
}

// ── Billing / Upgrade ───────────────────────────────────────────
export function trackUpgradeClicked() {
  capture("upgrade_clicked");
}

export function trackUpgradeCompleted() {
  capture("upgrade_completed");
}

export function trackSubscriptionCanceled() {
  capture("subscription_canceled");
}

export function trackSubscriptionReactivated() {
  capture("subscription_reactivated");
}

// ── Quota ───────────────────────────────────────────────────────
export function trackQuotaWarningShown(plan: string, usagePercent: number) {
  capture("quota_warning_shown", { plan, usage_percent: Math.round(usagePercent) });
}

// ── Account ─────────────────────────────────────────────────────
export function trackApiKeyCreated() {
  capture("api_key_created");
}

export function trackAccountDeleted() {
  capture("account_deleted");
}

// ── Request inspection ───────────────────────────────────────────
export function trackRequestViewed(method: string) {
  capture("request_viewed", { method });
}

export function trackRequestDetailTabChanged(tab: string) {
  capture("request_detail_tab_changed", { tab });
}

export function trackPayloadSchemaCopied(format: string, samples: number) {
  capture("payload_schema_copied", { format, samples });
}

export function trackRequestShared(expiresInDays: number, hideSensitive: boolean) {
  capture("request_shared", { expires_in_days: expiresInDays, hide_sensitive: hideSensitive });
}

// ── Endpoint management ──────────────────────────────────────────
export function trackEndpointDeleted() {
  capture("endpoint_deleted");
}

export function trackEndpointUpdated(fields: string[]) {
  capture("endpoint_updated", { fields });
}

export function trackMockResponseConfigured(statusCode: number, hasBody: boolean) {
  capture("mock_response_configured", { status_code: statusCode, has_body: hasBody });
}

/** Compare previous and current endpoint state, fire relevant tracking events. */
export function trackEndpointSaved(
  prev: {
    name: string;
    mockStatus: string;
    mockBody: string;
  },
  next: {
    name: string;
    mockStatus: string;
    mockBody: string;
  }
) {
  const changedFields: string[] = [];
  if (next.name !== prev.name) changedFields.push("name");

  const nextHasMock = Boolean(next.mockBody) || next.mockStatus !== "200";
  const mockChanged = next.mockStatus !== prev.mockStatus || next.mockBody !== prev.mockBody;

  if (mockChanged) changedFields.push("mock_response");
  if (changedFields.length > 0) trackEndpointUpdated(changedFields);
  if (mockChanged && nextHasMock) {
    trackMockResponseConfigured(parseInt(next.mockStatus, 10) || 200, Boolean(next.mockBody));
  }
}

// ── Export ────────────────────────────────────────────────────────
export function trackRequestExported(format: "json" | "csv", requestCount: number) {
  capture("request_exported", { format, request_count: requestCount });
}

// ── Replay ───────────────────────────────────────────────────────
export function trackRequestReplayed(method: string, responseStatus: number) {
  capture("request_replayed", { method, response_status: responseStatus });
}

// ── Send test webhook ────────────────────────────────────────────
export function trackTestWebhookSent(mode: string, responseStatus: number) {
  capture("test_webhook_sent", { mode, response_status: responseStatus });
}

// ── Free tools (/tools) ──────────────────────────────────────────
/**
 * A free tool was used. Only which tool, what was done and how it ended (an
 * HTTP status or a verdict): never the webhook URL, the secret, the message
 * or the provider's answer, which stay in the browser.
 */
export function trackToolUsed(tool: string, action: string, outcome: string) {
  capture("tool_used", { tool, action, outcome });
}

// ── Teams ───────────────────────────────────────────────────────
export function trackTeamCreated() {
  capture("team_created");
}

export function trackTeamMemberInvited(status: "success" | "error") {
  capture("team_member_invited", { status });
}

export function trackTeamInviteAccepted() {
  capture("team_invite_accepted");
}

export function trackTeamInviteDeclined() {
  capture("team_invite_declined");
}

export function trackTeamMemberRemoved() {
  capture("team_member_removed");
}

export function trackTeamLeft() {
  capture("team_left");
}

export function trackTeamDeleted() {
  capture("team_deleted");
}

export function trackEndpointTeamToggled(action: "shared" | "unshared") {
  capture("endpoint_team_toggled", { action });
}

export function trackTeamSubscribeClicked(seats: number) {
  capture("team_subscribe_clicked", { seats });
}

// ── Guest / Ephemeral ───────────────────────────────────────────
export function trackGuestEndpointCreated() {
  capture("guest_endpoint_created");
}

// ── CLI Auth ────────────────────────────────────────────────────
export function trackCliDeviceAuthorized() {
  capture("cli_device_authorized");
}

// ── Dashboard interactions ──────────────────────────────────────
export function trackEndpointSwitched() {
  capture("endpoint_switched");
}

export function trackEndpointFavorited(favorite: boolean) {
  capture(favorite ? "endpoint_favorited" : "endpoint_unfavorited");
}

// ── Sign out ────────────────────────────────────────────────────
export function trackSignOut() {
  capture("sign_out");
}

// ── Identify (after login) ──────────────────────────────────────
/**
 * Ties this browser to an account, only once the visitor has accepted
 * analytics. Never pass the email address: analytics name accounts by id only.
 */
export function identifyUser(userId: string, properties?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  if (!analyticsConsentGranted()) {
    // Kept for the identify that follows an accept.
    if (properties) pendingProperties = { ...pendingProperties, ...properties };
    return;
  }
  try {
    posthog.identify(userId, properties);
  } catch {
    // PostHog not initialized
  }
}

interface AuthedUser {
  id: string;
}

let reportedUserId: string | null = null;
/** Person properties offered before consent, sent with the identify after it. */
let pendingProperties: Record<string, unknown> | undefined;
/** The signed-in user while the visitor has not accepted analytics, identified if they do. */
let pendingUser: AuthedUser | null = null;

/** True once the visitor accepted analytics storage in the cookie banner. */
export function analyticsConsentGranted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return posthog.get_explicit_consent_status() === "granted";
  } catch {
    return false;
  }
}

/**
 * Ties this browser's events to the signed-in account. The shared auth store
 * calls it on every session change, so it runs on whatever page the user lands
 * on; repeat calls for the same user do nothing. Without analytics consent the
 * browser stays anonymous (cookieless) and the account is only identified once
 * the visitor accepts. Signups are recorded on the server
 * (lib/analytics-reporter.ts), whatever the browser allows.
 */
export function reportAuthenticatedUser(user: AuthedUser) {
  if (typeof window === "undefined" || user.id === reportedUserId) return;
  // Also covers a session reported before posthog.init ran: PostHogProvider
  // calls identifyPendingUser once PostHog has loaded.
  if (!analyticsConsentGranted()) {
    pendingUser = user;
    return;
  }
  reportedUserId = user.id;
  pendingUser = null;
  const properties = pendingProperties;
  pendingProperties = undefined;
  identifyUser(user.id, properties);
}

/** Called once PostHog has loaded and when the visitor accepts: identifies a waiting user. */
export function identifyPendingUser() {
  if (pendingUser) reportAuthenticatedUser(pendingUser);
}

/** Called when the session ends: a later accept must not identify the former account. */
export function clearPendingUser() {
  pendingUser = null;
  pendingProperties = undefined;
}

/** Called when the visitor declines: PostHog dropped the identity, so a later accept identifies again. */
export function forgetIdentifiedUser() {
  if (!reportedUserId) return;
  pendingUser = { id: reportedUserId };
  reportedUserId = null;
}

export function resetUser() {
  if (typeof window === "undefined") return;
  reportedUserId = null;
  pendingUser = null;
  pendingProperties = undefined;
  try {
    posthog.reset();
  } catch {
    // PostHog not initialized
  }
}
