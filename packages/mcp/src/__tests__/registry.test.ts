import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The MCP Registry entry (server.json) is published from the release
// workflow and checked against the npm package, so they must agree.
const root = join(__dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const server = JSON.parse(readFileSync(join(root, "server.json"), "utf-8"));

describe("server.json", () => {
  it("names the server as package.json does", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.name).toMatch(/^io\.github\.kroqdotdev\//);
  });

  it("carries the package version", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({
      registryType: "npm",
      identifier: pkg.name,
      version: pkg.version,
      transport: { type: "stdio" },
    });
  });

  it("lists the hosted server as a streamable HTTP remote", () => {
    expect(server.remotes).toEqual([{ type: "streamable-http", url: "https://webhooks.cc/mcp" }]);
  });

  it("keeps the description within the registry's 100 characters", () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});
