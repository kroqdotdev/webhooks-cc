import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default withSentryConfig(nextConfig, {
  silent: true,
  org: "webhooks-cc",
  project: "javascript-nextjs",
  // Skip source map upload when no auth token is provided
  authToken: process.env.SENTRY_AUTH_TOKEN,
});
