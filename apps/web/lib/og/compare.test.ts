import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPARE_PAGE_SLUGS, generatedOgImagePath } from "@/lib/seo";
import { compareToolName } from "./compare";

describe("compare page images", () => {
  it("names tools the way they write themselves", () => {
    expect(compareToolName("webhook-site")).toBe("Webhook.site");
    expect(compareToolName("ngrok")).toBe("ngrok");
    expect(compareToolName("hookdeck")).toBe("Hookdeck");
  });

  it("has no image for a page that does not exist", () => {
    expect(compareToolName("no-such-tool")).toBeNull();
    expect(compareToolName("constructor")).toBeNull();
    expect(generatedOgImagePath("/compare/no-such-tool")).toBeNull();
  });

  it("covers every compare page in app/compare", () => {
    // A page gets its image by being in the sitemap list (lib/seo.ts).
    const dir = join(__dirname, "../../app/compare");
    const pages = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "page.tsx")))
      .map((entry) => entry.name);
    expect(pages.length).toBeGreaterThan(0);
    for (const slug of pages) {
      expect(COMPARE_PAGE_SLUGS, `/compare/${slug} is missing from PUBLIC_SITEMAP_PAGES`).toContain(
        slug
      );
    }
  });
});

describe("generatedOgImagePath", () => {
  it("points the pages with their own image at the route beside them", () => {
    expect(generatedOgImagePath("/compare")).toBe("/compare/opengraph-image");
    expect(generatedOgImagePath("/compare/ngrok")).toBe("/compare/ngrok/opengraph-image");
    expect(generatedOgImagePath("/webhooks")).toBe("/webhooks/opengraph-image");
    expect(generatedOgImagePath("/webhooks/stripe")).toBe("/webhooks/stripe/opengraph-image");
    expect(generatedOgImagePath("/blog/a-post")).toBe("/blog/a-post/opengraph-image");
  });

  it("leaves every other page on the shared image", () => {
    for (const path of ["/", "/blog", "/pricing", "/docs/cli", "/blog/preview/a-post", "/s/abc"]) {
      expect(generatedOgImagePath(path)).toBeNull();
    }
  });
});
