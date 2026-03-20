import posthog from "posthog-js";

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

// ── Auth ────────────────────────────────────────────────────────
export function trackSignInStarted(provider: "github" | "google") {
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
