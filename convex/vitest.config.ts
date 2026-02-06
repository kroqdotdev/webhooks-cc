import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    setupFiles: ["./convex/test.globalSetup.ts"],
    env: {
      // auth.config.ts throws at module load without this
      CONVEX_SITE_URL: "https://test.convex.site",
    },
  },
});
