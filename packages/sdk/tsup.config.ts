import { defineConfig } from "tsup";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

export default defineConfig({
  entry: {
    index: "src/index.ts",
    testing: "src/testing.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  define: { PKG_VERSION: JSON.stringify(pkg.version) },
});
