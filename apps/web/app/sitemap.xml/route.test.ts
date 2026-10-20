import { describe, expect, it, vi } from "vitest";
import { GET } from "./route";

vi.mock("@/lib/supabase/blog-posts", () => ({
  listPublishedBlogPosts: vi.fn().mockResolvedValue([]),
}));

describe("GET /sitemap.xml", () => {
  it("returns valid sitemap XML with a Last-Modified header matching the newest entry", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");

    const lastModifiedHeader = response.headers.get("last-modified");
    expect(lastModifiedHeader).toBeTruthy();
    expect(Number.isNaN(Date.parse(lastModifiedHeader!))).toBe(false);

    const xml = await response.text();
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<loc>https://webhooks.cc</loc>");
    expect(xml).toContain("<loc>https://webhooks.cc/webhooks/paddle</loc>");

    const lastmodMatches = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) =>
      new Date(m[1]).getTime()
    );
    expect(lastmodMatches.length).toBeGreaterThan(0);

    const maxLastmodDate = new Date(Math.max(...lastmodMatches));
    expect(lastModifiedHeader).toBe(maxLastmodDate.toUTCString());
  });
});
