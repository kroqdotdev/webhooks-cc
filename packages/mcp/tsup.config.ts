import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    clean: true,
  },
  {
    entry: ["bin/mcp.ts"],
    format: ["cjs"],
    outDir: "dist/bin",
    banner: { js: "#!/usr/bin/env node" },
    // Bundle setup.ts into the bin so it's self-contained
    noExternal: [/^\.\.\/src/],
  },
]);
