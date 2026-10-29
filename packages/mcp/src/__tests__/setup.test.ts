import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devinMcpConfigPath, legacyWindsurfConfigPath, runSetup } from "../setup";

describe("devinMcpConfigPath", () => {
  it("uses ~/.config/devin on Linux and macOS", () => {
    for (const os of ["linux", "darwin"]) {
      expect(devinMcpConfigPath(os, "/home/acme", {})).toBe(
        "/home/acme/.config/devin/mcp_config.json"
      );
    }
  });

  it("follows an absolute XDG_CONFIG_HOME and ignores a relative one", () => {
    expect(devinMcpConfigPath("linux", "/home/acme", { XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/devin/mcp_config.json"
    );
    expect(devinMcpConfigPath("linux", "/home/acme", { XDG_CONFIG_HOME: "xdg" })).toBe(
      "/home/acme/.config/devin/mcp_config.json"
    );
  });

  it("uses %APPDATA%\\devin on Windows", () => {
    expect(devinMcpConfigPath("win32", "C:\\Users\\acme", { APPDATA: "D:\\Roaming" })).toBe(
      "D:\\Roaming\\devin\\mcp_config.json"
    );
    expect(devinMcpConfigPath("win32", "C:\\Users\\acme", {})).toBe(
      "C:\\Users\\acme\\AppData\\Roaming\\devin\\mcp_config.json"
    );
  });
});

// os.homedir() reads HOME on Linux and macOS, so each test points it at a
// fresh directory and setup writes there.
describe.skipIf(process.platform === "win32")("setup devin and windsurf", () => {
  let home: string;
  const saved = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    WHK_API_KEY: process.env.WHK_API_KEY,
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "whk-setup-"));
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.WHK_API_KEY;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  const devinFile = () => join(home, ".config", "devin", "mcp_config.json");
  const read = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

  it("writes Devin's user-level config and keeps the servers already there", () => {
    mkdirSync(join(home, ".config", "devin"), { recursive: true });
    writeFileSync(devinFile(), JSON.stringify({ mcpServers: { other: { command: "other" } } }));

    runSetup(["devin", "--api-key", "whcc_test123"]);

    expect(read(devinFile()).mcpServers).toEqual({
      other: { command: "other" },
      "webhooks-cc": {
        command: "npx",
        args: ["-y", "@webhooks-cc/mcp"],
        env: { WHK_API_KEY: "whcc_test123" },
      },
    });
  });

  it("treats windsurf as devin and never creates the old Windsurf directory", () => {
    runSetup(["windsurf"]);

    expect(read(devinFile()).mcpServers["webhooks-cc"]).toEqual({
      command: "npx",
      args: ["-y", "@webhooks-cc/mcp"],
    });
    expect(existsSync(join(home, ".codeium"))).toBe(false);
  });

  it("also updates the old Windsurf config where Windsurf is installed", () => {
    mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });

    runSetup(["windsurf"]);

    expect(legacyWindsurfConfigPath()).toBe(join(home, ".codeium", "windsurf", "mcp_config.json"));
    expect(read(legacyWindsurfConfigPath()).mcpServers["webhooks-cc"]).toBeDefined();
    expect(read(devinFile()).mcpServers["webhooks-cc"]).toBeDefined();
  });
});
