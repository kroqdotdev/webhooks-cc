import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  output: "standalone",
  headers: async () => [
    {
      source: "/_next/static/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        {
          key: "Cache-Control",
          value: "public, max-age=31536000, immutable",
        },
      ],
    },
  ],
};

export default withSentryConfig(nextConfig, {
  silent: true,
  org: "webhooks-cc",
  project: "javascript-nextjs",
  // Skip source map upload when no auth token is provided
  authToken: process.env.SENTRY_AUTH_TOKEN,
});
