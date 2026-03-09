import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    testing: "src/testing.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
});
