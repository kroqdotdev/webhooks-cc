import { describe, expect, it } from "vitest";
import { getAllDocSlugs } from "./docs";
import { NAV_SECTIONS } from "./docs-nav";

describe("NAV_SECTIONS", () => {
  // proxy.ts reads the doc paths from the nav to give an unknown doc on
  // mailhooks.cc that site's own 404, so the nav must list every doc.
  it("lists every doc in content/docs, and no doc that is not there", async () => {
    const docs = (await getAllDocSlugs()).map((slug) => (slug ? `/docs/${slug}` : "/docs")).sort();
    const nav = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.href))
      .filter((href) => href === "/docs" || href.startsWith("/docs/"))
      .sort();
    expect(nav).toEqual(docs);
  });
});
