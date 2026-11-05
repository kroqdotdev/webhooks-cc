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

describe("the other sitemap formats", () => {
  it("lists the same URLs as plain text, one per line", async () => {
    const { GET: getText } = await import("../sitemap.txt/route");
    const xml = await (await GET()).text();
    const response = await getText();
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const lines = (await response.text()).trimEnd().split("\n");
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(lines).toEqual(locs);
    expect(lines.every((line) => line.startsWith("https://"))).toBe(true);
  });

  it("lists the same URLs as RSS 2.0 items with pubDates", async () => {
    const { GET: getRss } = await import("../sitemap.rss/route");
    const xml = await (await GET()).text();
    const response = await getRss();
    expect(response.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    const rss = await response.text();
    expect(rss).toContain('<rss version="2.0">');
    const links = [...rss.matchAll(/<item>\n<title>[^<]*<\/title>\n<link>([^<]+)<\/link>/g)].map(
      (m) => m[1]
    );
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(links).toEqual(locs);
    const dates = [...rss.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map((m) => Date.parse(m[1]));
    expect(dates).toHaveLength(locs.length);
    expect(dates.every((d) => !Number.isNaN(d))).toBe(true);
  });

  it("serves mailhooks.cc's URLs in all three formats", async () => {
    const { GET: mailXml } = await import("../mailhooks/sitemap.xml/route");
    const { GET: mailText } = await import("../mailhooks/sitemap.txt/route");
    const { GET: mailRss } = await import("../mailhooks/sitemap.rss/route");
    const locs = [...(await mailXml().text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.length).toBeGreaterThan(5);
    expect(locs.every((loc) => loc.includes("mailhooks"))).toBe(true);
    expect((await mailText().text()).trimEnd().split("\n")).toEqual(locs);
    expect([...(await mailRss().text()).matchAll(/<link>([^<]+)<\/link>/g)].length).toBe(
      locs.length + 1
    );
  });
});
