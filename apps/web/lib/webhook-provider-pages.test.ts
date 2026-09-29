import { describe, expect, it } from "vitest";
import { TEMPLATE_PROVIDERS } from "@webhooks-cc/sdk";
import {
  getAllWebhookProviderPages,
  getWebhookProviderPage,
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
});
