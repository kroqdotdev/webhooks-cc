import { defineConfig } from "vitest/config";
import path from "path";
import dotenv from "dotenv";

// Load .env.local from the monorepo root (symlinked into apps/web)
dotenv.config({ path: path.resolve(__dirname, ".env.local") });

// Integration tests exercise encrypted signing-secret paths. Use a deterministic
// test-only key when local development env does not provide one.
process.env.SIGNING_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");

// The Realtime suite waits for single broadcast signals, and the local Realtime
// server drops signals above its rate limits. Every other suite's captures send
// signals too, so the Realtime suite runs on its own after them.
const REALTIME_SUITE = "tests/integration/supabase-realtime.test.ts";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          exclude: [REALTIME_SUITE],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "realtime",
          include: [REALTIME_SUITE],
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
