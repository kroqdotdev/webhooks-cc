import { defineConfig } from "vitest/config";
import path from "path";
import dotenv from "dotenv";

// Load .env.local from the monorepo root (symlinked into apps/web)
dotenv.config({ path: path.resolve(__dirname, ".env.local") });

// Integration tests exercise encrypted signing-secret paths. Use a deterministic
// test-only key when local development env does not provide one.
process.env.SIGNING_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
