import type { NextConfig } from "next";

// auth.md discovery URL. Mirrors lib/agent/metadata.ts buildAuthMdUrl(), but
// resolved here from raw env because next.config runs outside the app's lazy
// publicEnv() loader. Same default as lib/env.ts (NEXT_PUBLIC_APP_URL).
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://webhooks.cc";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@webhooks-cc/sdk"],
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
    ];
  },
};

export default nextConfig;
