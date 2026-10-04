import { describe, expect, it } from "vitest";
import { TEMPLATE_PROVIDERS } from "@webhooks-cc/sdk";
import {
  getAllWebhookProviderPages,
  getWebhookProviderPage,
  getWebhookProvidersLastModified,
  indefiniteArticle,
  WEBHOOK_PROVIDER_CATEGORIES,
  WEBHOOK_PROVIDER_SLUGS,
} from "./webhook-provider-pages";

describe("webhook provider pages", () => {
  const pages = getAllWebhookProviderPages();
  const captureOnly = pages.filter((page) => !page.inSdk);

  it("has one page per slug, including every SDK provider", () => {
    expect(new Set(WEBHOOK_PROVIDER_SLUGS).size).toBe(WEBHOOK_PROVIDER_SLUGS.length);
    expect(pages.map((page) => page.slug)).toEqual([...WEBHOOK_PROVIDER_SLUGS]);
    for (const provider of TEMPLATE_PROVIDERS) {
      expect(getWebhookProviderPage(provider)?.inSdk).toBe(true);
    }
  });

  it("keeps capture-only pages out of SDK features", () => {
    expect(captureOnly.length).toBeGreaterThan(0);
    for (const page of captureOnly) {
      expect(page.templates).toEqual([]);
      expect(page.verifySupported).toBe(false);
      expect(page.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("uses known categories and no em dashes in capture-only copy", () => {
    for (const page of captureOnly) {
      expect(WEBHOOK_PROVIDER_CATEGORIES).toContain(page.category);
      const copy = [page.blurb, page.configHint, page.signatureNote ?? ""].join(" ");
      expect(copy).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it("marks opt-in signing as optional, and never for SDK providers", () => {
    for (const slug of ["segment", "zapier", "chargebee", "jira", "mailchimp"]) {
      expect(getWebhookProviderPage(slug)?.signatureOptional).toBe(true);
    }
    expect(getWebhookProviderPage("pagerduty")?.signatureOptional).toBe(false);
    for (const page of pages.filter((p) => p.inSdk)) {
      expect(page.signatureOptional).toBe(false);
    }
  });

  it("picks an before vowel-initial labels", () => {
    expect(indefiniteArticle("Amazon SNS")).toBe("an");
    expect(indefiniteArticle("Okta")).toBe("an");
    expect(indefiniteArticle("intercom")).toBe("an");
    expect(indefiniteArticle("Stripe")).toBe("a");
    expect(indefiniteArticle("WorkOS")).toBe("a");
  });

  it("gives every page a real lastModified between launch and now", () => {
    const launch = new Date("2026-06-14T00:00:00.000Z");
    for (const page of pages) {
      expect(Number.isNaN(page.lastModified.getTime()), page.slug).toBe(false);
      expect(page.lastModified >= launch, page.slug).toBe(true);
      expect(page.lastModified <= new Date(), page.slug).toBe(true);
    }
  });

  it("dates new and changed pages by their change, and the hub by the newest page", () => {
    expect(getWebhookProviderPage("zapier")?.lastModified.toISOString()).toBe(
      "2026-10-02T00:00:00.000Z"
    );
    expect(getWebhookProviderPage("resend")?.lastModified.toISOString()).toBe(
      "2026-10-02T00:00:00.000Z"
    );
    expect(getWebhookProviderPage("bigcommerce")?.lastModified.toISOString()).toBe(
      "2026-09-29T00:00:00.000Z"
    );
    // #446 changed the FAQ wording ("an") on vowel-initial pages on 3 October.
    for (const slug of ["adyen", "airtable", "auth0", "aws-sns", "intercom", "okta"]) {
      expect(getWebhookProviderPage(slug)?.lastModified.toISOString(), slug).toBe(
        "2026-10-03T00:00:00.000Z"
      );
    }
    const newest = Math.max(...pages.map((page) => page.lastModified.getTime()));
    expect(getWebhookProvidersLastModified().getTime()).toBe(newest);
  });
});
