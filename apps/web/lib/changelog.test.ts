import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_VERSION, CHANGELOG, MCP_VERSION, SDK_VERSION } from "./changelog";

/**
 * Guards against version drift between the public changelog page and what is
 * actually shipped: the web app's own package.json, and the SDK/MCP package
 * versions that the publish workflows read when a tag is pushed. (The CLI
 * version comes from the git tag at build time, so it has no file to compare.)
 */
function readPackageVersion(relativePath: string): string {
  const file = resolve(__dirname, "..", relativePath);
  const pkg = JSON.parse(readFileSync(file, "utf8")) as { version?: string };
  if (!pkg.version) throw new Error(`${relativePath} has no version`);
  return pkg.version;
}

describe("changelog version constants", () => {
  it("APP_VERSION matches apps/web/package.json", () => {
    expect(APP_VERSION).toBe(readPackageVersion("package.json"));
  });

  it("SDK_VERSION matches packages/sdk/package.json", () => {
    expect(SDK_VERSION).toBe(readPackageVersion("../../packages/sdk/package.json"));
  });

  it("MCP_VERSION matches packages/mcp/package.json", () => {
    expect(MCP_VERSION).toBe(readPackageVersion("../../packages/mcp/package.json"));
  });

  it("the newest entry of each track matches its version constant", () => {
    const newest = (track: string) => CHANGELOG.find((entry) => entry.track === track)?.version;
    expect(newest("web")).toBe(APP_VERSION);
    expect(newest("sdk")).toBe(SDK_VERSION);
    expect(newest("mcp")).toBe(MCP_VERSION);
  });
});
