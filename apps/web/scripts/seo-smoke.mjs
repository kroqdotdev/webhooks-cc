#!/usr/bin/env node

/* global console, fetch, process, URL */

const baseUrl = (process.env.SEO_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const siteUrl = "https://webhooks.cc";

function normalizePath(url) {
  const parsed = new URL(url, siteUrl);
  return `${parsed.pathname}${parsed.search}` || "/";
}

function readFirst(html, re) {
  const match = html.match(re);
  return match ? match[1] : "";
}

function count(html, re) {
  return (html.match(re) || []).length;
}

async function fetchText(url, opts = {}) {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "webhooks.cc SEO smoke check" },
      ...opts,
    });
    const text = await response.text();
    return { response, text };
  } catch (err) {
    throw new Error(`Failed to fetch ${url}: ${err.message}. Is the server running at ${baseUrl}?`);
  }
}

async function main() {
  const errors = [];
  const warnings = [];

  // Fetch the sitemap index and extract child sitemap URLs
  const sitemapIndex = await fetchText(`${baseUrl}/sitemap-index.xml`);
  if (!sitemapIndex.response.ok) {
    throw new Error(
      `Failed to fetch sitemap-index.xml from ${baseUrl}: ${sitemapIndex.response.status}`
    );
  }

  const childSitemapUrls = [...sitemapIndex.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

  // Collect all page URLs from child sitemaps
  const sitemapUrls = [];
  for (const childUrl of childSitemapUrls) {
    const childPath = normalizePath(childUrl);
    const child = await fetchText(`${baseUrl}${childPath}`);
    if (!child.response.ok) {
      errors.push(`Sitemap ${childPath}: HTTP ${child.response.status}`);
      continue;
    }
    const urls = [...child.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    sitemapUrls.push(...urls);
  }

  if (sitemapUrls.length === 0) {
    throw new Error("No URLs found in sitemaps");
  }

  const sitemapPathSet = new Set(sitemapUrls.map((url) => normalizePath(url)));
  for (const excludedPath of ["/login", "/api-explorer"]) {
    if (sitemapPathSet.has(excludedPath)) {
      errors.push(`${excludedPath}: should not appear in public sitemap`);
    }
  }

  for (const canonicalUrl of sitemapUrls) {
    const path = normalizePath(canonicalUrl);
    const page = await fetchText(`${baseUrl}${path}`);
    const html = page.text;

    const title = readFirst(html, /<title>([^<]*)<\/title>/i);
    const description = readFirst(
      html,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i
    );
    const robots = readFirst(html, /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i);
    const canonical = readFirst(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i);
    const h1Count = count(html, /<h1\b/gi);
    const mainOrArticleCount = count(html, /<(main|article)\b/gi);

    if (page.response.status !== 200)
      errors.push(`${path}: expected 200, got ${page.response.status}`);
    if (!title) errors.push(`${path}: missing <title>`);
    if (!description) errors.push(`${path}: missing meta description`);
    if (/\bnoindex\b/i.test(robots) || !/\bindex\b/i.test(robots))
      errors.push(`${path}: expected indexable robots meta`);
    if (canonical !== canonicalUrl && !(path === "/" && canonical === siteUrl)) {
      errors.push(`${path}: canonical mismatch (${canonical || "missing"})`);
    }
    if (h1Count !== 1) errors.push(`${path}: expected exactly 1 <h1>, found ${h1Count}`);
    if (mainOrArticleCount < 1) errors.push(`${path}: expected <main> or <article> in raw HTML`);

    if (description.length < 120 || description.length > 170) {
      warnings.push(`${path}: description length ${description.length} (target 120-170)`);
    }

    // Check for duplicate branding in title
    const brandMatches = (title.match(/webhooks\.cc/gi) || []).length;
    if (brandMatches > 1) {
      warnings.push(`${path}: title contains "webhooks.cc" ${brandMatches} times`);
    }

    if (path.startsWith("/blog/")) {
      const ogType = readFirst(
        html,
        /<meta[^>]+property=["']og:type["'][^>]+content=["']([^"']*)["']/i
      );
      if (ogType !== "article") errors.push(`${path}: expected og:type=article`);
      if (!html.includes('"@type":"BlogPosting"'))
        errors.push(`${path}: missing BlogPosting JSON-LD`);
    }

    if (path === "/" && !/application\/rss\+xml/i.test(html)) {
      errors.push("/: missing RSS alternate link");
    }

    if (
      (path.startsWith("/docs") || path.startsWith("/blog") || path.startsWith("/compare")) &&
      !html.includes('"@type":"BreadcrumbList"')
    ) {
      errors.push(`${path}: missing BreadcrumbList JSON-LD`);
    }
  }

  // Check noindex on private routes
  const login = await fetchText(`${baseUrl}/login`);
  const loginRobots = readFirst(
    login.text,
    /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i
  );
  if (!/noindex/i.test(loginRobots)) {
    errors.push("/login: missing noindex robots meta");
  }

  const apiHealth = await fetchText(`${baseUrl}/api/health`);
  if (!/noindex/i.test(apiHealth.response.headers.get("x-robots-tag") || "")) {
    errors.push("/api/health: missing X-Robots-Tag noindex header");
  }

  // Check that /teams is noindexed
  const teams = await fetchText(`${baseUrl}/teams`);
  const teamsRobots = readFirst(
    teams.text,
    /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i
  );
  if (!/noindex/i.test(teamsRobots)) {
    errors.push("/teams: missing noindex robots meta");
  }

  // Check /sitemap.xml redirects (use redirect: manual to observe the 301)
  const sitemapXml = await fetchText(`${baseUrl}/sitemap.xml`, { redirect: "manual" });
  if (sitemapXml.response.status !== 301) {
    warnings.push(`/sitemap.xml: expected 301, got ${sitemapXml.response.status}`);
  } else {
    const location = sitemapXml.response.headers.get("location") || "";
    if (!location.endsWith("/sitemap-index.xml")) {
      warnings.push(`/sitemap.xml: redirect target is "${location}", expected /sitemap-index.xml`);
    }
  }

  if (warnings.length) {
    console.log("SEO warnings:");
    for (const warning of warnings) console.log(`- ${warning}`);
  }

  if (errors.length) {
    console.error("SEO errors:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  console.log(`SEO smoke check passed for ${sitemapUrls.length} sitemap URLs (${baseUrl}).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
