#!/usr/bin/env node

/* global console, fetch, process, URL */

const baseUrl = (process.env.SEO_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const siteUrl = "https://webhooks.cc";

function normalizePath(url) {
  if (url.startsWith(siteUrl)) return url.slice(siteUrl.length) || "/";
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function readFirst(html, re) {
  const match = html.match(re);
  return match ? match[1] : "";
}

function count(html, re) {
  return (html.match(re) || []).length;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "webhooks.cc SEO smoke check" },
  });
  const text = await response.text();
  return { response, text };
}

async function main() {
  const errors = [];
  const warnings = [];

  const sitemap = await fetchText(`${baseUrl}/sitemap.xml`);
  if (!sitemap.response.ok) {
    throw new Error(`Failed to fetch sitemap.xml from ${baseUrl}: ${sitemap.response.status}`);
  }

  const sitemapUrls = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
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
    if (!robots.includes("index")) errors.push(`${path}: expected indexable robots meta`);
    if (canonical !== canonicalUrl && !(path === "/" && canonical === siteUrl)) {
      errors.push(`${path}: canonical mismatch (${canonical || "missing"})`);
    }
    if (h1Count !== 1) errors.push(`${path}: expected exactly 1 <h1>, found ${h1Count}`);
    if (mainOrArticleCount < 1) errors.push(`${path}: expected <main> or <article> in raw HTML`);

    if (description.length < 120 || description.length > 170) {
      warnings.push(`${path}: description length ${description.length} (target 120-170)`);
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

  const login = await fetchText(`${baseUrl}/login`);
  if (!/noindex/i.test(login.response.headers.get("x-robots-tag") || "")) {
    errors.push("/login: missing X-Robots-Tag noindex header");
  }
  if (
    !/noindex/i.test(
      readFirst(login.text, /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i)
    )
  ) {
    errors.push("/login: missing noindex robots meta");
  }

  const apiHealth = await fetchText(`${baseUrl}/api/health`);
  if (!/noindex/i.test(apiHealth.response.headers.get("x-robots-tag") || "")) {
    errors.push("/api/health: missing X-Robots-Tag noindex header");
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
