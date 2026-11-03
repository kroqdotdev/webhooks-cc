import { describe, expect, it } from "vitest";
import { redactAnalyticsEvent, redactUrls, REDACTED_SHARE_PATH } from "./analytics-redact";

describe("redactAnalyticsEvent", () => {
  it("removes share tokens from URLs, referrers and autocaptured links", () => {
    const token = "A7LKv3_NOY7Chfp0DHkXmg";
    const event = redactAnalyticsEvent({
      event: "$pageview",
      properties: {
        $current_url: `https://webhooks.cc/s/${token}`,
        $pathname: `/s/${token}`,
        $referrer: `https://webhooks.cc/s/${token}?x=1`,
        $elements: [{ attr__href: `/s/${token}`, tag_name: "a" }],
        $elements_chain: `a:href="/s/${token}"`,
        other: "/settings/share",
        count: 3,
      },
    });
    expect(JSON.stringify(event)).not.toContain(token);
    expect(event.properties?.$pathname).toBe(REDACTED_SHARE_PATH);
    expect(event.properties?.$referrer).toBe(`https://webhooks.cc${REDACTED_SHARE_PATH}`);
    expect(event.properties?.other).toBe("/settings/share");
    expect(event.properties?.count).toBe(3);
  });

  it("drops endpoint slugs, Polar session tokens and auth codes, in person fields too", () => {
    // The shape posthog-js hands to before_send: $set and $set_once beside properties.
    const event = redactAnalyticsEvent({
      uuid: "0199-uuid",
      event: "$identify",
      properties: {
        $current_url: "https://webhooks.cc/dashboard?endpoint=acme-slug-123&tab=email",
        $elements_chain: 'a:href="/dashboard?endpoint=acme-slug-123"nth-child="1"',
        $referrer: "https://webhooks.cc/auth/callback?code=abc#access_token=jwt",
      },
      $set_once: {
        $initial_current_url:
          "https://webhooks.cc/account/plan?customer_session_token=polar_cst_secret&upgraded=1",
      },
      $set: { plan: "pro" },
    });
    const text = JSON.stringify(event);
    for (const secret of ["acme-slug-123", "polar_cst_secret", "code=abc", "jwt"]) {
      expect(text).not.toContain(secret);
    }
    expect(event.uuid).toBe("0199-uuid");
    expect(event.properties.$current_url).toBe("https://webhooks.cc/dashboard?tab=email");
    expect(event.$set_once.$initial_current_url).toBe(
      "https://webhooks.cc/account/plan?upgraded=1"
    );
    expect(event.properties.$elements_chain).toBe('a:href="/dashboard"nth-child="1"');
    expect(event.properties.$referrer).toBe("https://webhooks.cc/auth/callback");
    expect(event.$set).toEqual({ plan: "pro" });
  });

  it("passes through a dropped event", () => {
    expect(redactAnalyticsEvent(null)).toBeNull();
  });
});

describe("redactUrls", () => {
  it("keeps campaign parameters and plain text", () => {
    expect(redactUrls("https://webhooks.cc/?utm_source=chatgpt.com&gclid=1&x=2")).toBe(
      "https://webhooks.cc/?utm_source=chatgpt.com&gclid=1"
    );
    expect(redactUrls("Create endpoint? Yes")).toBe("Create endpoint? Yes");
    expect(redactUrls("1/2?")).toBe("1/2?");
  });
});

describe("staff pages", () => {
  it("sends nothing from the operations center", async () => {
    const { analyticsBeforeSend, isUntrackedPath } = await import("./analytics-redact");
    expect(isUntrackedPath("/ops")).toBe(true);
    expect(isUntrackedPath("/ops/tickets/1002")).toBe(true);
    expect(isUntrackedPath("/opsx")).toBe(false);
    expect(analyticsBeforeSend({ event: "$pageview" }, "/ops/accounts")).toBeNull();
    expect(analyticsBeforeSend({ event: "$pageview" }, "/support")).toEqual({ event: "$pageview" });
  });
});
