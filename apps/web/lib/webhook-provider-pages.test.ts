import { describe, expect, it } from "vitest";
import { TEMPLATE_PROVIDERS } from "@webhooks-cc/sdk";
import {
  getAllWebhookProviderPages,
  getRelatedProviderPages,
  getWebhookProviderPage,
  getWebhookProvidersLastModified,
  indefiniteArticle,
  RELATED_LINKS_CHANGED,
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

  it("dates pages by their newest change, and the hub by the newest page", () => {
    // The related-links change on 26 October touched every page, so it is the
    // floor; an edit of a page's own content after it moves that page on.
    for (const page of pages) {
      expect(page.lastModified.toISOString().slice(0, 10) >= RELATED_LINKS_CHANGED, page.slug).toBe(
        true
      );
    }
    expect(getWebhookProviderPage("zapier")?.lastModified.toISOString()).toBe(
      `${RELATED_LINKS_CHANGED}T00:00:00.000Z`
    );
    const newest = Math.max(...pages.map((page) => page.lastModified.getTime()));
    expect(getWebhookProvidersLastModified().getTime()).toBe(newest);
  });

  it("keeps search-driven copy short, dash-free and tied to real pages", () => {
    const withSeo = pages.filter((page) => page.seo);
    expect(withSeo.map((page) => page.slug).sort()).toEqual([
      "adyen",
      "cal",
      "checkout-com",
      "clerk",
      "coinbase-commerce",
      "discord",
      "docusign",
      "intercom",
      "lemonsqueezy",
      "linear",
      "mux",
      "paddle",
      "razorpay",
      "sendgrid",
      "square",
    ]);
    for (const page of withSeo) {
      const seo = page.seo!;
      // Google cuts titles near 60 characters.
      if (seo.title) expect(seo.title.length, page.slug).toBeLessThanOrEqual(60);
      const copy = [
        seo.title ?? "",
        seo.description ?? "",
        ...(seo.faq ?? []).flatMap((item) => [item.question, item.answer]),
        ...(seo.reference ? [seo.reference.heading, seo.reference.intro] : []),
        ...(seo.reference?.rows.flat() ?? []),
      ].join(" ");
      expect(copy, page.slug).not.toContain(String.fromCharCode(0x2014));
      expect(
        [
          "2026-10-13T00:00:00.000Z",
          "2026-10-20T00:00:00.000Z",
          "2026-10-23T00:00:00.000Z",
          "2026-10-26T00:00:00.000Z",
        ],
        page.slug
      ).toContain(page.lastModified.toISOString());
    }
  });

  it("links every page from its siblings, three each, within the category", () => {
    const inbound = new Map<string, number>();
    for (const page of pages) {
      const related = getRelatedProviderPages(page.slug);
      const siblings = pages.filter((p) => p.category === page.category).length;
      expect(related).toHaveLength(Math.min(3, siblings - 1));
      expect(new Set(related.map((p) => p.slug)).size).toBe(related.length);
      for (const other of related) {
        expect(other.slug).not.toBe(page.slug);
        expect(other.category).toBe(page.category);
        inbound.set(other.slug, (inbound.get(other.slug) ?? 0) + 1);
      }
    }
    for (const page of pages) {
      const siblings = pages.filter((p) => p.category === page.category).length;
      expect(inbound.get(page.slug) ?? 0, page.slug).toBe(Math.min(3, siblings - 1));
    }
  });
});
