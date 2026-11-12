import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatedOgImagePath, PUBLIC_SITEMAP_PAGES } from "@/lib/seo";
import { existsOnWebhooks, servedOnMailhooks } from "@/lib/site";
import {
  getAllShareFrameworkPages,
  getRelatedShareFrameworkPages,
  getShareFrameworkPage,
  getShareFrameworksLastModified,
  SHARE_FRAMEWORK_GROUPS,
  SHARE_FRAMEWORK_SLUGS,
  SHARE_PAGE_UPDATED,
  shareCommand,
} from "./share-framework-pages";

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

describe("share framework pages", () => {
  const pages = getAllShareFrameworkPages();

  /** Every string a page shows, for the checks that read all of it. */
  function copyOf(page: (typeof pages)[number]): string {
    return [
      page.card,
      page.title,
      page.description,
      page.h1,
      page.intro,
      page.hostSetting,
      page.withoutIt,
      page.hotReload,
      page.urlsAndCookies,
      ...page.sections.flatMap((section) => [
        section.heading,
        ...section.body,
        section.snippet?.code ?? "",
        section.after ?? "",
      ]),
      ...page.faq.flatMap((item) => [item.question, item.answer]),
      ...page.sources.map((source) => source.label),
    ].join("\n");
  }

  it("has one page per slug, with the frameworks the pages were made for", () => {
    expect(new Set(SHARE_FRAMEWORK_SLUGS).size).toBe(SHARE_FRAMEWORK_SLUGS.length);
    expect(pages.map((page) => page.slug)).toEqual([...SHARE_FRAMEWORK_SLUGS]);
    for (const slug of [
      "nextjs",
      "vite",
      "nuxt",
      "sveltekit",
      "astro",
      "angular",
      "rails",
      "laravel",
      "django",
      "flask",
      "express",
    ]) {
      expect(getShareFrameworkPage(slug), slug).not.toBeNull();
    }
    for (const page of pages) {
      expect(page.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(SHARE_FRAMEWORK_GROUPS).toContain(page.group);
    }
    expect(getShareFrameworkPage("no-such-framework")).toBeNull();
    expect(getShareFrameworkPage("constructor")).toBeNull();
  });

  it("shares each framework's default port", () => {
    const ports: Record<string, number> = {
      nextjs: 3000,
      vite: 5173,
      nuxt: 3000,
      sveltekit: 5173,
      astro: 4321,
      angular: 4200,
      express: 3000,
      webpack: 8080,
      rails: 3000,
      laravel: 8000,
      django: 8000,
      flask: 5000,
      fastapi: 8000,
      phoenix: 4000,
    };
    expect(Object.keys(ports).sort()).toEqual([...SHARE_FRAMEWORK_SLUGS].sort());
    for (const page of pages) {
      expect(page.port, page.slug).toBe(ports[page.slug]);
      expect(shareCommand(page)).toBe(`whk share ${page.port}`);
      // The page says the command somewhere beyond the code block at its top.
      expect(copyOf(page), page.slug).toContain(shareCommand(page));
    }
  });

  it("names the setting each framework's own docs name", () => {
    const settings: Record<string, string[]> = {
      nextjs: ["allowedDevOrigins", "x-forwarded-host"],
      vite: ["server.allowedHosts"],
      nuxt: ["useRequestURL", "allowedHosts"],
      sveltekit: ["csrf.trustedOrigins", "paths.origin"],
      astro: ["server.allowedHosts", "security.allowedDomains", "security.checkOrigin"],
      angular: ["allowedHosts", "trustProxyHeaders"],
      express: ["trust proxy"],
      webpack: ["allowedHosts", "client.webSocketURL"],
      rails: ["config.hosts"],
      laravel: ["trustProxies", "APP_URL"],
      django: ["CSRF_TRUSTED_ORIGINS", "ALLOWED_HOSTS", "SECURE_PROXY_SSL_HEADER"],
      flask: ["ProxyFix", "TRUSTED_HOSTS"],
      fastapi: ["--no-proxy-headers"],
      phoenix: ["check_origin"],
    };
    for (const page of pages) {
      const copy = copyOf(page);
      for (const setting of settings[page.slug] ?? []) {
        expect(copy, `${page.slug}: ${setting}`).toContain(setting);
      }
    }
  });

  it("quotes the message a developer would search for, where there is one", () => {
    const messages: Record<string, string> = {
      nextjs: "Blocked cross-origin request to Next.js dev resource",
      vite: "Blocked request. This host",
      sveltekit: "Cross-site POST form submissions are forbidden",
      astro: "Cross-site POST form submissions are forbidden",
      angular: "Blocked request. This host",
      webpack: "Invalid Host header",
      rails: "Blocked hosts:",
      django: "Origin checking failed",
      phoenix: "Could not check origin for Phoenix.Socket transport",
    };
    for (const [slug, message] of Object.entries(messages)) {
      expect(copyOf(getShareFrameworkPage(slug)!), slug).toContain(message);
    }
  });

  it("never claims a test: the pages cite documentation", () => {
    for (const page of pages) {
      expect(copyOf(page), page.slug).not.toMatch(
        /\b(we|I) (tested|verified|tried)\b|\btested (with|on|against)\b/i
      );
      expect(page.sources.length, page.slug).toBeGreaterThanOrEqual(3);
      for (const source of page.sources) {
        expect(source.href, page.slug).toMatch(/^https:\/\//);
      }
      expect(new Set(page.sources.map((source) => source.href)).size).toBe(page.sources.length);
      expect(page.version, page.slug).toMatch(/^\d+(\.\d+)?$/);
    }
  });

  it("keeps titles and descriptions to what a search result shows", () => {
    for (const page of pages) {
      // Google cuts titles near 60 characters.
      expect(page.title.length, `${page.slug}: ${page.title}`).toBeLessThanOrEqual(60);
      expect(page.description.length, page.slug).toBeGreaterThanOrEqual(110);
      expect(page.description.length, page.slug).toBeLessThanOrEqual(260);
      expect(page.description, page.slug).toContain(shareCommand(page));
      expect(page.keywords.length, page.slug).toBeGreaterThanOrEqual(5);
    }
    expect(new Set(pages.map((page) => page.title)).size).toBe(pages.length);
    expect(new Set(pages.map((page) => page.h1)).size).toBe(pages.length);
    expect(new Set(pages.map((page) => page.description)).size).toBe(pages.length);
  });

  it("gives every page content of its own", () => {
    const headings = new Map<string, string>();
    const paragraphs = new Map<string, string>();
    const questions = new Map<string, string>();
    for (const page of pages) {
      expect(page.sections.length, page.slug).toBeGreaterThanOrEqual(3);
      expect(page.faq.length, page.slug).toBeGreaterThanOrEqual(4);
      for (const section of page.sections) {
        expect(headings.get(section.heading), `${page.slug}: ${section.heading}`).toBeUndefined();
        headings.set(section.heading, page.slug);
        expect(section.body.length, `${page.slug}: ${section.heading}`).toBeGreaterThan(0);
        for (const paragraph of [...section.body, ...(section.after ? [section.after] : [])]) {
          expect(
            paragraphs.get(paragraph),
            `${page.slug} repeats ${paragraphs.get(paragraph)}`
          ).toBe(undefined);
          paragraphs.set(paragraph, page.slug);
        }
      }
      for (const item of page.faq) {
        expect(questions.get(item.question), `${page.slug}: ${item.question}`).toBeUndefined();
        questions.set(item.question, page.slug);
        // Answers go into FAQ structured data and the accordion as plain text.
        expect(item.answer, `${page.slug}: ${item.question}`).not.toContain("`");
        expect(item.question).not.toContain("`");
      }
    }
  });

  it("writes no dashes that are not hyphens, and pairs its backticks", () => {
    for (const page of pages) {
      const copy = copyOf(page);
      expect(copy, page.slug).not.toContain(EM_DASH);
      expect(copy, page.slug).not.toContain(EN_DASH);
      const prose = [
        page.intro,
        page.hostSetting,
        page.withoutIt,
        page.hotReload,
        page.urlsAndCookies,
        ...page.sections.flatMap((section) => [...section.body, section.after ?? ""]),
      ];
      for (const text of prose) {
        expect((text.match(/`/g) ?? []).length % 2, `${page.slug}: ${text.slice(0, 60)}`).toBe(0);
      }
      // A card is shown as plain text.
      expect(page.card, page.slug).not.toContain("`");
    }
  });

  it("dates every page between the launch and now, and the hub by the newest", () => {
    const launch = new Date(`${SHARE_PAGE_UPDATED}T00:00:00.000Z`);
    for (const page of pages) {
      expect(Number.isNaN(page.lastModified.getTime()), page.slug).toBe(false);
      expect(page.lastModified >= new Date("2026-11-12T00:00:00.000Z"), page.slug).toBe(true);
      expect(page.lastModified <= new Date(), page.slug).toBe(true);
    }
    const newest = Math.max(launch.getTime(), ...pages.map((page) => page.lastModified.getTime()));
    expect(getShareFrameworksLastModified().getTime()).toBe(newest);
  });

  it("links every page from three others in its group", () => {
    const inbound = new Map<string, number>();
    for (const page of pages) {
      const related = getRelatedShareFrameworkPages(page.slug);
      expect(related).toHaveLength(3);
      expect(new Set(related.map((p) => p.slug)).size).toBe(3);
      for (const other of related) {
        expect(other.slug).not.toBe(page.slug);
        expect(other.group).toBe(page.group);
        inbound.set(other.slug, (inbound.get(other.slug) ?? 0) + 1);
      }
    }
    for (const page of pages) {
      expect(inbound.get(page.slug) ?? 0, page.slug).toBe(3);
    }
    expect(getRelatedShareFrameworkPages("no-such-framework")).toEqual([]);
  });
});

describe("/share on the two sites", () => {
  it("is webhooks.cc's: mailhooks.cc sends it there, and /s share links are untouched", () => {
    for (const path of ["/share", "/share/nextjs", "/share/opengraph-image"]) {
      expect(servedOnMailhooks(path), path).toBe(false);
      expect(existsOnWebhooks(path), path).toBe(true);
    }
    // The request share links live at /s/<token>, which mailhooks.cc serves.
    expect(servedOnMailhooks("/s/token")).toBe(true);
  });

  it("is in the sitemap list and has its own images", () => {
    expect(PUBLIC_SITEMAP_PAGES.map((page) => page.path)).toContain("/share");
    expect(generatedOgImagePath("/share")).toBe("/share/opengraph-image");
    expect(generatedOgImagePath("/share/nextjs")).toBe("/share/nextjs/opengraph-image");
    expect(generatedOgImagePath("/s/abc")).toBeNull();
    const app = join(__dirname, "../app/share");
    expect(existsSync(join(app, "opengraph-image/route.tsx"))).toBe(true);
    expect(existsSync(join(app, "[framework]/opengraph-image/route.tsx"))).toBe(true);
  });

  it("is linked from the docs that describe whk share", () => {
    const docs = join(__dirname, "../../../content/docs");
    const share = readFileSync(join(docs, "share.mdx"), "utf8");
    expect(share).toContain("](/share#frameworks)");
    for (const slug of SHARE_FRAMEWORK_SLUGS) {
      expect(share, slug).toContain(`](/share/${slug})`);
    }
    expect(readFileSync(join(docs, "cli/index.mdx"), "utf8")).toContain("](/share#frameworks)");
    expect(readFileSync(join(docs, "cli/commands.mdx"), "utf8")).toContain("](/share#frameworks)");
  });
});
