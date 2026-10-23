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
  transpilePackages: ["@webhooks-cc/sdk"],
  experimental: {
    // simple-icons is a huge barrel package; rewrite named imports to direct
    // per-icon paths so client bundles only carry the icons actually used.
    optimizePackageImports: ["simple-icons"],
  },
  async headers() {
    return [
      {
        // Advertise the auth.md agent-registration document on every response
        // via a Link header, so agents that only inspect response headers (no
        // HTML parse) still discover it. Complements the <link rel="auth.md">
        // in app/layout.tsx and the RFC 9728 WWW-Authenticate challenge on 401s.
        // No registered IANA relation exists, so we reuse the spec's filename
        // as the relation, matching the HTML <link>.
        source: "/:path*",
        headers: [{ key: "Link", value: `<${appUrl}/auth.md>; rel="auth.md"` }],
      },
      {
        // The auth.md v0.1 routes are deprecated (RFC 9745); the routes set
        // Deprecation and Sunset. A later rule's Link replaces the one above,
        // so this one carries both relations. `:path*` matches the bare
        // /api/agent/auth too.
        source: "/api/agent/auth/:path*",
        headers: [
          {
            key: "Link",
            value: `<${appUrl}/auth.md>; rel="auth.md", <${appUrl}/auth.md>; rel="deprecation"`,
          },
        ],
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
  async redirects() {
    return [
      {
        // /go is retired - the landing page now IS the guest dashboard.
        // Permanent redirect preserves the page's search rankings and backlinks.
        source: "/go",
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
    ];
  },
};

export default nextConfig;
