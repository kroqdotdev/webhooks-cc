import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: "../..",
  envPrefix: ["VITE_", "WHK_"],
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // Separate processes: the setup tests point HOME at a temp directory, and
    // os.homedir() in a worker thread would still return the real one.
    pool: "forks",
  },
});
