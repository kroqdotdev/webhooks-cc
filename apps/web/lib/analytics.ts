import posthog from "posthog-js";
import { UI_STYLE_FLAG_KEY, type UiStyle, type UiStyleSource } from "./ui-style";

/**
 * Track custom analytics events via PostHog.
 * All calls are safe to make even if PostHog is not initialized — they no-op.
 */

function capture(event: string, properties?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    posthog.capture(event, properties);
  } catch {
    // PostHog not initialized — silently ignore
  }
}

// ── Landing page ────────────────────────────────────────────────
export function trackCTAClick(cta: "register" | "try_live" | "docs" | "faq") {
  capture("landing_cta_clicked", { cta });
}

// ── Visual style experiment ────────────────────────────

/**
 * Tells PostHog which arm of the style split this browser is in. The variant
 * stays the one the split assigned even after the visitor switches styles, so
 * a switch does not move their later events into the other arm.
 */
export function registerStyleVariant(assigned: UiStyle) {
  if (typeof window === "undefined") return;
  try {
    posthog.register({ [`$feature/${UI_STYLE_FLAG_KEY}`]: assigned });
  } catch {
    // PostHog not initialized
  }
}

/** Exposure event PostHog counts experiment participants from. Once per session. */
export function trackStyleExposure(assigned: UiStyle, active: UiStyle) {
  capture("$feature_flag_called", {
    $feature_flag: UI_STYLE_FLAG_KEY,
    $feature_flag_response: assigned,
    ui_style_active: active,
  });
}

/** The metric that moves fastest: how many people leave the style they landed on. */
export function trackUiStyleChanged(params: {
  from: UiStyle;
  to: UiStyle;
  sourceBefore: UiStyleSource | null;
  assigned: UiStyle | null;
}) {
  capture("ui_style_changed", {
    from: params.from,
    to: params.to,
    source_before: params.sourceBefore ?? "default",
    assigned_variant: params.assigned ?? "none",
    left_assigned_style: params.assigned != null && params.from === params.assigned,
    $set: { ui_style: params.to },
  });
}

// ── Auth ────────────────────────────────────────────────────────
export function trackSignInStarted(provider: "github" | "google" | "email") {
  capture("sign_in_started", { provider });
}

/**
 * Fired once per account, on the first authenticated page load after signup.
 * It is the completed side of sign_in_started: without it a funnel cannot tie
 * a signup back to the anonymous visitor who was assigned a style.
 */
export function trackAccountCreated(provider?: string) {
  capture("account_created", { provider: provider ?? "unknown" });
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

export function trackSubscriptionCancelled() {
  capture("subscription_cancelled");
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

// ── Sign out ────────────────────────────────────────────────────
export function trackSignOut() {
  capture("sign_out");
}

// ── Identify (after login) ──────────────────────────────────────
export function identifyUser(userId: string, properties?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    posthog.identify(userId, properties);
  } catch {
    // PostHog not initialized
  }
}

export function resetUser() {
  if (typeof window === "undefined") return;
  try {
    posthog.reset();
  } catch {
    // PostHog not initialized
  }
}
