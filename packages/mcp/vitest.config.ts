import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: "../..",
  envPrefix: ["VITE_", "WHK_"],
  test: {
    setupFiles: ["./vitest.setup.ts"],
  },
});
