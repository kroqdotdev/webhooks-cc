import { readFileSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// auth.md discovery URL. Mirrors lib/agent/metadata.ts buildAuthMdUrl(), but
// resolved here from raw env because next.config runs outside the app's lazy
// publicEnv() loader. Same default as lib/env.ts (NEXT_PUBLIC_APP_URL).
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://webhooks.cc";

// The browser's StatOSS release, like the server's (lib/observability-start.ts).
const webVersion = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
const gitSha = process.env.GIT_SHA?.trim().slice(0, 12);

// Discovery relations sent on every response (RFC 8288), so agents that only
// read headers still find them: auth.md for agent registration (no registered
// IANA relation exists, so the spec's filename is the relation, matching the
// <link rel="auth.md"> in app/layout.tsx) and the RFC 9727 API catalog. A
// later rule's Link replaces an earlier one, so every rule that sets Link
// below builds on these.
const discoveryLinks = [
  `<${appUrl}/auth.md>; rel="auth.md"`,
  `<${appUrl}/.well-known/api-catalog>; rel="api-catalog"`,
];
const linkHeader = (...extra: string[]) => [...discoveryLinks, ...extra].join(", ");
// The markdown twin of a page (lib/markdown-negotiation.ts).
const markdownTwin = (pathname: string) =>
  `<${appUrl}${pathname}>; rel="alternate"; type="text/markdown"`;
// The same URL answers with HTML or markdown, so caches must key on Accept.
// This reaches the markdown responses; Next replaces Vary on the pages it
// renders, so the HTML variant only gets it from the edge.
const varyAccept = { key: "Vary", value: "Accept" };
// Set by proxy.ts on a request that prefers markdown; the name is
// MARKDOWN_TWIN_HEADER in lib/markdown-negotiation.ts.
const prefersMarkdown = [{ type: "header" as const, key: "x-markdown-twin", value: "1" }];

// mailhooks.cc (lib/site.ts): its own pages live in app/mailhooks and are
// served at its root by host. A host match ignores the port.
function hostnameOf(value: string | undefined): string | null {
  try {
    return value ? new URL(value).hostname : null;
  } catch {
    return null;
  }
}
const mailhooksHost = hostnameOf(process.env.NEXT_PUBLIC_MAILHOOKS_URL);
// The value is a regular expression: every special character is escaped
// (a hostname has dots), so it matches the host exactly.
const onMailhooks = mailhooksHost
  ? [{ type: "host" as const, value: mailhooksHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }]
  : [];
const mailhooksRewrites = mailhooksHost
  ? [
      { source: "/", has: onMailhooks, destination: "/mailhooks" },
      { source: "/pricing", has: onMailhooks, destination: "/mailhooks/pricing" },
      { source: "/parse", has: onMailhooks, destination: "/mailhooks/parse" },
      { source: "/parse/:path*", has: onMailhooks, destination: "/mailhooks/parse/:path*" },
      // The feature pages (lib/mailhooks-features.ts).
      ...["/google-sheets", "/file-drops", "/custom-domains", "/ai-setup", "/integrations"].map(
        (source) => ({ source, has: onMailhooks, destination: `/mailhooks${source}` })
      ),
      { source: "/robots.txt", has: onMailhooks, destination: "/mailhooks/robots.txt" },
      { source: "/sitemap.xml", has: onMailhooks, destination: "/mailhooks/sitemap.xml" },
    ]
  : [];

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_STATOSS_RELEASE: `webhooks-web@${webVersion}${gitSha ? `+${gitSha}` : ""}`,
  },
  // Browser source maps only for a build that uploads them to StatOSS and
  // then deletes them (apps/web/Dockerfile); they are never served.
  productionBrowserSourceMaps: process.env.STATOSS_SOURCEMAPS === "1",
  // Pin the tracing root to the monorepo root. Without this, Next walks up
  // past the repo looking for a lockfile and a stray ~/package.json makes the
  // standalone output land under .next/standalone/<home-relative-path>/,
  // breaking the post-build public/static copy in the build script.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // lib/agent-skills.ts reads the plugin's skills from the repository at
  // runtime when a route is not prerendered, like lib/docs.ts reads
  // content/docs (which the Dockerfile copies instead).
  outputFileTracingIncludes: {
    "/.well-known/agent-skills/**": ["../../plugins/webhooks-cc/skills/**/*.md"],
  },
  transpilePackages: ["@webhooks-cc/sdk"],
  experimental: {
    // simple-icons is a huge barrel package; rewrite named imports to direct
    // per-icon paths so client bundles only carry the icons actually used.
    optimizePackageImports: ["simple-icons"],
  },
  async headers() {
    return [
      {
        // The discovery relations on every response. Complements the HTML
        // <link> elements and the RFC 9728 WWW-Authenticate challenge on 401s.
        source: "/:path*",
        headers: [{ key: "Link", value: linkHeader() }],
      },
      {
        // Pages with a markdown twin (proxy.ts) point to it and vary on Accept.
        source: "/",
        headers: [{ key: "Link", value: linkHeader(markdownTwin("/index.md")) }, varyAccept],
      },
      {
        source: "/docs",
        headers: [{ key: "Link", value: linkHeader(markdownTwin("/docs.md")) }, varyAccept],
      },
      {
        // Every docs page except the .md URLs themselves; :path is filled
        // into the header value.
        source: "/docs/:path((?!.*\\.md$).+)",
        headers: [{ key: "Link", value: linkHeader(markdownTwin("/docs/:path.md")) }, varyAccept],
      },
      {
        // The auth.md v0.1 routes are deprecated (RFC 9745); the routes set
        // Deprecation and Sunset. `:path*` matches the bare /api/agent/auth too.
        source: "/api/agent/auth/:path*",
        headers: [{ key: "Link", value: linkHeader(`<${appUrl}/auth.md>; rel="deprecation"`) }],
      },
      {
        // Explicit X-Robots-Tag header at the Next.js router layer in addition
        // to proxy.ts and layout metadata so crawlers always see noindex.
        source: "/dashboard/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        // GoTrue fetches its email templates from here, through Cloudflare.
        // no-transform keeps Cloudflare's rewrites out of them: its email
        // obfuscation turned support@webhooks.cc into a "[email protected]"
        // link plus a script, which would have gone out in the email.
        source: "/email-templates/:file",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, no-transform" }],
      },
    ];
  },
  async rewrites() {
    return {
      // Markdown twins (lib/markdown-negotiation.ts). These run after
      // proxy.ts, which marks the requests that prefer markdown, and stay
      // inside the server, unlike a proxy.ts rewrite to an absolute URL.
      beforeFiles: [
        // mailhooks.cc's pages come first: its root is not webhooks.cc's.
        ...mailhooksRewrites,
        // A route segment cannot end in ".md", so the docs twins live
        // under /docs.md; an index page's twin is its directory's.
        { source: "/docs/index.md", destination: "/docs.md" },
        { source: "/docs/:path(.+)/index.md", destination: "/docs.md/:path" },
        { source: "/docs/:path(.+)\\.md", destination: "/docs.md/:path" },
        { source: "/", has: prefersMarkdown, destination: "/index.md" },
        { source: "/docs", has: prefersMarkdown, destination: "/docs.md" },
        { source: "/docs/:path(.+)", has: prefersMarkdown, destination: "/docs.md/:path" },
      ],
    };
  },
  async redirects() {
    return [
      {
        // /go is retired - the landing page now IS the guest dashboard.
        // Permanent redirect preserves the page's search rankings and backlinks.
        // The go command's ?go-get=1 lookups for webhooks.cc/go (the Go SDK's
        // import path) skip it and reach app/go/[[...path]]/route.ts.
        source: "/go",
        missing: [{ type: "query", key: "go-get" }],
        destination: "/",
        permanent: true,
      },
      {
        // The sitemap index and its child sitemaps were folded into one /sitemap.xml.
        source: "/sitemap-index.xml",
        destination: "/sitemap.xml",
        permanent: true,
      },
      {
        source: "/sitemaps/:file",
        destination: "/sitemap.xml",
        permanent: true,
      },
      {
        // Devs and LLMs guess both /webhooks/amazon-sns and /webhooks/aws-sns;
        // canonical slug in webhook-provider-pages.ts is aws-sns.
        source: "/webhooks/amazon-sns",
        destination: "/webhooks/aws-sns",
        permanent: true,
      },
      {
        // Legacy/guessed comparison paths seen in Search Console.
        source: "/compare/webhooks-cc",
        destination: "/compare",
        permanent: true,
      },
      {
        source: "/compare/webhooks-cc-vs-webhook-site",
        destination: "/compare/webhook-site",
        permanent: true,
      },
      {
        // Docs guides folded into the /compare pages, which cover the same ground.
        source: "/docs/guides/ngrok-vs-webhooks-cc",
        destination: "/compare/ngrok",
        permanent: true,
      },
      {
        source: "/docs/guides/webhook-site-vs-webhooks-cc",
        destination: "/compare/webhook-site",
        permanent: true,
      },
      {
        source: "/docs/guides/webhook-testing-tools",
        destination: "/compare",
        permanent: true,
      },
      {
        // Blog posts merged into the docs guides on the same topic. Their rows
        // are unpublished, so they also leave /blog and the sitemap.
        source: "/blog/webhook-testing-cicd-typescript",
        destination: "/docs/guides/webhook-testing-ci-cd",
        permanent: true,
      },
      {
        source: "/blog/test-stripe-webhooks-locally-2026",
        destination: "/docs/guides/test-stripe-webhooks",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
