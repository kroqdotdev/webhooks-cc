import { defineConfig } from "tsup";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const define = { PKG_VERSION: JSON.stringify(pkg.version) };

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    clean: true,
    define,
  },
  {
    entry: ["bin/mcp.ts"],
    format: ["cjs"],
    outDir: "dist/bin",
    banner: { js: "#!/usr/bin/env node" },
    // Bundle setup.ts into the bin so it's self-contained
    noExternal: [/^\.\.\/src/],
    define,
  },
]);
