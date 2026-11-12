import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPARE_PAIRS,
  comparePair,
  comparePairName,
  comparePairsFor,
  requireComparePair,
} from "./compare-pairs";
import { COMPARE_PAGE_SLUGS, PUBLIC_SITEMAP_PAGES, generatedOgImagePath } from "./seo";

const compareDir = join(__dirname, "../app/compare");
const pageFile = (slug: string) => join(compareDir, slug, "page.tsx");

describe("pair comparison pages", () => {
  it("has a page folder for every pair, and a pair for every folder", () => {
    const folders = readdirSync(compareDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.includes("-vs-"))
      .map((entry) => entry.name)
      .sort();
    expect(folders).toEqual(COMPARE_PAIRS.map((pair) => pair.slug).sort());

    for (const pair of COMPARE_PAIRS) {
      const source = readFileSync(pageFile(pair.slug), "utf8");
      expect(source, pair.slug).toContain(`requireComparePair("${pair.slug}")`);
    }
  });

  it("names each page after its two tools", () => {
    const slugs = new Set<string>();
    for (const pair of COMPARE_PAIRS) {
      expect(pair.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*-vs-[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(slugs.has(pair.slug), `${pair.slug} is listed twice`).toBe(false);
      slugs.add(pair.slug);
      expect(pair.a.name).not.toBe(pair.b.name);
    }
  });

  it("leads every title with X vs Y, so it never targets a tool's alternative search", () => {
    for (const pair of COMPARE_PAIRS) {
      expect(pair.title.startsWith(comparePairName(pair)), pair.title).toBe(true);
      expect(pair.title.toLowerCase(), pair.title).not.toContain("alternative");
      expect(pair.title.length, pair.title).toBeLessThanOrEqual(62);
    }
  });

  it("keeps descriptions inside the length search results show", () => {
    for (const pair of COMPARE_PAIRS) {
      expect(pair.description.length, pair.slug).toBeGreaterThanOrEqual(120);
      expect(pair.description.length, pair.slug).toBeLessThanOrEqual(170);
    }
  });

  it("lists every pair in the sitemap, which also gives it a share image", () => {
    const paths = PUBLIC_SITEMAP_PAGES.map((page) => page.path);
    for (const pair of COMPARE_PAIRS) {
      const path = `/compare/${pair.slug}`;
      expect(paths, path).toContain(path);
      expect(COMPARE_PAGE_SLUGS).toContain(pair.slug);
      expect(generatedOgImagePath(path)).toBe(`${path}/opengraph-image`);
    }
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("fills in every part of a page", () => {
    for (const pair of COMPARE_PAIRS) {
      expect(pair.intro.length, pair.slug).toBeGreaterThan(80);
      expect(pair.rows.length, pair.slug).toBeGreaterThanOrEqual(8);
      for (const row of pair.rows) {
        expect(row).toHaveLength(3);
        for (const cell of row) expect(cell.trim(), `${pair.slug}: ${row[0]}`).not.toBe("");
      }
      expect(pair.sources).toContain(pair.a.name);
      expect(pair.sources).toContain(pair.b.name);
      for (const tool of [pair.a, pair.b]) {
        expect(tool.about.length, `${pair.slug}: ${tool.name}`).toBeGreaterThan(120);
        expect(tool.pick.length, `${pair.slug}: ${tool.name}`).toBeGreaterThanOrEqual(2);
      }
      expect(pair.fit.length, pair.slug).toBeGreaterThanOrEqual(1);
      expect(pair.fit.join(" "), pair.slug).toContain("webhooks.cc");
      expect(pair.faq.length, pair.slug).toBeGreaterThanOrEqual(3);
      expect(pair.keywords).toContain(comparePairName(pair).toLowerCase());
    }
  });

  it("repeats nothing the page uses as a list key", () => {
    const unique = (values: readonly string[], what: string) =>
      expect(new Set(values).size, what).toBe(values.length);
    for (const pair of COMPARE_PAIRS) {
      unique(
        pair.rows.map((row) => row[0]),
        `${pair.slug} rows`
      );
      unique(
        pair.faq.map((item) => item.question),
        `${pair.slug} questions`
      );
      unique(pair.fit, `${pair.slug} fit`);
      unique(
        pair.fitLinks.map((link) => link.href),
        `${pair.slug} links`
      );
      unique(pair.a.pick, `${pair.slug} ${pair.a.name}`);
      unique(pair.b.pick, `${pair.slug} ${pair.b.name}`);
    }
  });

  it("links to our own comparison with each tool, and that page links back", () => {
    for (const pair of COMPARE_PAIRS) {
      for (const tool of [pair.a, pair.b]) {
        const href = tool.compareHref;
        expect(href, `${pair.slug}: ${tool.name}`).toBeDefined();
        if (!href) continue;
        expect(
          pair.fitLinks.map((link) => link.href),
          pair.slug
        ).toContain(href);

        const file = pageFile(href.replace("/compare/", ""));
        expect(existsSync(file), href).toBe(true);
        expect(readFileSync(file, "utf8"), href).toContain(`<PairLinks tool="${href}" />`);
      }
    }
  });

  it("points its compare links at pages that exist", () => {
    for (const pair of COMPARE_PAIRS) {
      for (const link of pair.fitLinks) {
        if (link.href === "/compare") continue;
        if (!link.href.startsWith("/compare/")) continue;
        expect(existsSync(pageFile(link.href.replace("/compare/", ""))), link.href).toBe(true);
      }
    }
  });

  it("uses no em or en dashes", () => {
    const dashes = [0x2013, 0x2014].map((code) => String.fromCharCode(code));
    const text = JSON.stringify(COMPARE_PAIRS);
    for (const dash of dashes) expect(text.includes(dash)).toBe(false);
  });
});

describe("pair lookups", () => {
  it("finds a pair by its slug", () => {
    expect(comparePair("ngrok-vs-hookdeck")?.b.name).toBe("Hookdeck");
    expect(comparePair("ngrok")).toBeUndefined();
    expect(comparePair("constructor")).toBeUndefined();
    expect(() => requireComparePair("no-such-pair")).toThrow(/no-such-pair/);
  });

  it("lists the pairs a tool's page links to", () => {
    expect(comparePairsFor("/compare/ngrok").map((pair) => pair.slug)).toEqual([
      "ngrok-vs-hookdeck",
      "ngrok-vs-webhook-site",
      "ngrok-vs-localtunnel",
      "ngrok-vs-cloudflare-tunnel",
    ]);
    expect(comparePairsFor("/compare/mailosaur").map((pair) => pair.slug)).toEqual([
      "mailtrap-vs-mailosaur",
    ]);
    expect(comparePairsFor("/compare/svix")).toEqual([]);
  });
});
