import { defineConfig } from "tsup";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const define = { PKG_VERSION: JSON.stringify(pkg.version) };

export default defineConfig([
  {
    // tools: the tool definitions alone, for the hosted server at webhooks.cc/mcp,
    // which runs them on its own MCP server without this package's stdio one.
    entry: { index: "src/index.ts", tools: "src/tools.ts" },
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
