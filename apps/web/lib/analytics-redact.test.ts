import { describe, expect, it } from "vitest";
import { redactShareTokens, REDACTED_SHARE_PATH } from "./analytics-redact";

describe("redactShareTokens", () => {
  it("removes share tokens from URLs, referrers and autocaptured links", () => {
    const token = "A7LKv3_NOY7Chfp0DHkXmg";
    const event = redactShareTokens({
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
    expect(event.properties?.$referrer).toBe(`https://webhooks.cc${REDACTED_SHARE_PATH}?x=1`);
    expect(event.properties?.other).toBe("/settings/share");
    expect(event.properties?.count).toBe(3);
  });

  it("passes through events without properties", () => {
    expect(redactShareTokens(null)).toBeNull();
    const bare = { event: "x", properties: undefined };
    expect(redactShareTokens(bare)).toBe(bare);
  });
});
