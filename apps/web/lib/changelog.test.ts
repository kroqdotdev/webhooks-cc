import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_VERSION,
  CHANGELOG,
  GO_SDK_VERSION,
  MCP_VERSION,
  PYTHON_SDK_VERSION,
  SDK_VERSION,
} from "./changelog";
import release from "./changelog-release.json";
import { validateFragment } from "../scripts/release.mjs";

/**
 * Guards against version drift between the public changelog page and what is
 * actually shipped: the SDK/MCP package versions that the publish workflows read when a tag is pushed. (The CLI
 * version comes from the git tag at build time, so it has no file to compare.)
 */
function readPackageVersion(relativePath: string): string {
  const file = resolve(__dirname, "..", relativePath);
  const pkg = JSON.parse(readFileSync(file, "utf8")) as { version?: string };
  if (!pkg.version) throw new Error(`${relativePath} has no version`);
  return pkg.version;
}

describe("changelog version constants", () => {
  it("the web version is given at deploy time, so the repository holds none", () => {
    // The deploy writes changelog-release.json for the build; a committed copy
    // would show a stale version in every later build.
    expect(release).toEqual({ version: null, entries: [] });
    expect(APP_VERSION).toBe("dev");
    expect(readPackageVersion("package.json")).toBe("0.0.0");
  });

  it("SDK_VERSION matches packages/sdk/package.json", () => {
    expect(SDK_VERSION).toBe(readPackageVersion("../../packages/sdk/package.json"));
  });

  it("PYTHON_SDK_VERSION matches packages/sdk-python/pyproject.toml", () => {
    const pyproject = readFileSync(
      resolve(__dirname, "..", "../../packages/sdk-python/pyproject.toml"),
      "utf8"
    );
    expect(PYTHON_SDK_VERSION).toBe(/^version = "([^"]+)"/m.exec(pyproject)?.[1]);
  });

  it("GO_SDK_VERSION matches Version in packages/sdk-go/doc.go", () => {
    const doc = readFileSync(resolve(__dirname, "..", "../../packages/sdk-go/doc.go"), "utf8");
    expect(GO_SDK_VERSION).toBe(/^const Version = "([^"]+)"/m.exec(doc)?.[1]);
  });

  it("MCP_VERSION matches packages/mcp/package.json", () => {
    expect(MCP_VERSION).toBe(readPackageVersion("../../packages/mcp/package.json"));
  });

  it("the newest entry of each track matches its version constant", () => {
    const newest = (track: string) => CHANGELOG.find((entry) => entry.track === track)?.version;
    expect(newest("sdk")).toBe(SDK_VERSION);
    expect(newest("python")).toBe(PYTHON_SDK_VERSION);
    expect(newest("go")).toBe(GO_SDK_VERSION);
    expect(newest("mcp")).toBe(MCP_VERSION);
  });
});

describe("web changelog files", () => {
  const dir = resolve(__dirname, "..", "changelog/web");
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));

  it.each(files.length ? files : ["(none)"])("%s is a valid changelog file", (name) => {
    if (name === "(none)") return;
    expect(validateFragment(name, readFileSync(resolve(dir, name), "utf8"))).toEqual([]);
  });
});
