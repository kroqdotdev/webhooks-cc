import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { WebhooksCC } from "../client";
import * as sdk from "../index";

// capabilities.json at the repository root says what a user can do and how
// each client reaches it. This suite holds it to the API routes and the
// TypeScript, Python and Go SDKs; the MCP server's and the CLI's own tests
// check their columns.

const repo = join(__dirname, "..", "..", "..", "..");
const read = (path: string) => readFileSync(path, "utf-8");

type Surface = "sdk" | "python" | "go" | "cli" | "mcp";
const SURFACES: Surface[] = ["sdk", "python", "go", "cli", "mcp"];

interface Capability extends Record<Surface, string[] | string> {
  id: string;
  does: string;
  routes: string[];
  sessionOnly?: string;
}

interface Manifest {
  capabilities: Capability[];
  internalRoutes: Record<string, string>;
  local: Record<"sdk" | "cli" | "mcp", Record<string, string>>;
}

const manifest = JSON.parse(read(join(repo, "capabilities.json"))) as Manifest;
const capabilities = manifest.capabilities;

/** The names a surface lists, or [] when it gives a reason instead. */
const names = (c: Capability, surface: Surface): string[] =>
  Array.isArray(c[surface]) ? (c[surface] as string[]) : [];

// ─── API routes ─────────────────────────────────────────────────────────

const apiDir = join(repo, "apps", "web", "app", "api");
const HANDLER = /export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE)\b/g;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return entry === "route.ts" ? [path] : [];
  });
}

/** "METHOD /api/path" for every handler, with the file that serves it. */
const routes = new Map<string, string>();
for (const file of routeFiles(apiDir)) {
  const path = "/api/" + relative(apiDir, file).split(sep).slice(0, -1).join("/");
  const source = read(file);
  for (const match of source.matchAll(HANDLER)) {
    routes.set(`${match[1]} ${path.replace(/\/$/, "")}`, source);
  }
}

const pathOf = (route: string) => route.slice(route.indexOf(" ") + 1);

function internalEntry(route: string): string | undefined {
  const path = pathOf(route);
  return Object.keys(manifest.internalRoutes).find((key) =>
    key.endsWith("/*")
      ? path === key.slice(0, -2) || path.startsWith(key.slice(0, -1))
      : path === key
  );
}

/** Routes that refuse API keys: only a browser session reaches them. */
const isSessionOnly = (source: string) =>
  /authenticateSessionRequest\(|domainAccount\(/.test(source);

describe("capabilities.json", () => {
  it("has a description and every surface for each capability", () => {
    const ids = new Set<string>();
    for (const c of capabilities) {
      expect(ids.has(c.id), `${c.id} is listed twice`).toBe(false);
      ids.add(c.id);
      expect(c.does, c.id).toBeTruthy();
      expect(Array.isArray(c.routes), c.id).toBe(true);
      for (const surface of SURFACES) {
        const value = c[surface];
        const ok = Array.isArray(value)
          ? value.length > 0 && value.every((n) => typeof n === "string" && n.length > 0)
          : typeof value === "string" && value.length > 0;
        expect(ok, `${c.id}: ${surface} needs names or a reason`).toBe(true);
      }
    }
  });

  it("lists every API route, as a capability or as internal", () => {
    const missing = [...routes.keys()].filter(
      (route) => !internalEntry(route) && !capabilities.some((c) => c.routes.includes(route))
    );
    expect(
      missing,
      "add these routes to a capability in capabilities.json (or to internalRoutes)"
    ).toEqual([]);
  });

  it("names only routes that exist, and none that are internal", () => {
    for (const c of capabilities) {
      for (const route of c.routes) {
        expect(routes.has(route), `${c.id}: no route ${route}`).toBe(true);
        expect(internalEntry(route), `${c.id}: ${route} is also internal`).toBeUndefined();
      }
    }
    for (const key of Object.keys(manifest.internalRoutes)) {
      expect(
        [...routes.keys()].some((route) => internalEntry(route) === key),
        `internalRoutes: ${key} matches no route`
      ).toBe(true);
    }
  });

  it("marks the capabilities whose routes take only a session", () => {
    for (const c of capabilities) {
      for (const route of c.routes) {
        expect(
          isSessionOnly(routes.get(route) ?? ""),
          c.sessionOnly
            ? `${c.id}: ${route} takes API keys, but the capability says sessionOnly`
            : `${c.id}: ${route} takes only a session; say why in sessionOnly`
        ).toBe(Boolean(c.sessionOnly));
      }
    }
  });
});

// ─── TypeScript SDK ─────────────────────────────────────────────────────

const client = new WebhooksCC({ apiKey: "whcc_capabilities" });

function clientFunctions(value: object, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, member]) => {
    const name = prefix + key;
    if (typeof member === "function") return [name];
    if (member && typeof member === "object" && !Array.isArray(member)) {
      return clientFunctions(member as object, `${name}.`);
    }
    return [];
  });
}

function resolvesInSdk(name: string): boolean {
  // WebhooksCC.sandbox() and the other static constructors.
  if (name.startsWith("WebhooksCC.")) {
    return typeof (WebhooksCC as unknown as Record<string, unknown>)[name.slice(11)] === "function";
  }
  let value: unknown = client;
  for (const part of name.split(".")) {
    value =
      value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  }
  if (typeof value === "function") return true;
  return !name.includes(".") && typeof (sdk as Record<string, unknown>)[name] === "function";
}

describe("capabilities.json and the TypeScript SDK", () => {
  it("names methods the SDK has", () => {
    for (const c of capabilities) {
      for (const name of names(c, "sdk")) {
        expect(resolvesInSdk(name), `${c.id}: the SDK has no ${name}`).toBe(true);
      }
    }
    for (const name of Object.keys(manifest.local.sdk)) {
      expect(resolvesInSdk(name), `local.sdk: the SDK has no ${name}`).toBe(true);
    }
  });

  it("lists every client method", () => {
    const listed = new Set([
      ...capabilities.flatMap((c) => names(c, "sdk")),
      ...Object.keys(manifest.local.sdk),
    ]);
    const missing = clientFunctions(client).filter((name) => !listed.has(name));
    expect(missing, "add these SDK methods to a capability in capabilities.json").toEqual([]);
  });
});

// ─── Python and Go SDKs ─────────────────────────────────────────────────

const pythonDir = join(repo, "packages", "sdk-python", "src", "webhooks_cc");
const pythonModules = readdirSync(pythonDir)
  .filter((file) => file.endsWith(".py"))
  .map((file) => read(join(pythonDir, file)));
const pythonClient = read(join(pythonDir, "client.py"));

function pythonClass(name: string): string | undefined {
  for (const source of pythonModules) {
    const start = source.search(new RegExp(`^class ${name}\\b`, "m"));
    if (start < 0) continue;
    // The class body: its indented lines, up to the next unindented one.
    const rest = source.slice(source.indexOf("\n", start) + 1);
    const end = rest.search(/^\S/m);
    return end < 0 ? rest : rest.slice(0, end);
  }
  return undefined;
}

const hasDef = (source: string | undefined, name: string) =>
  source !== undefined && new RegExp(`^\\s+def ${name}\\(`, "m").test(source);

function resolvesInPython(name: string): boolean {
  const parts = name.split(".");
  if (parts.length === 1) {
    return (
      hasDef(pythonClass("WebhooksCC"), name) ||
      pythonModules.some((source) => new RegExp(`^def ${name}\\(`, "m").test(source))
    );
  }
  const [attribute, method] = parts;
  const cls = new RegExp(`self\\.${attribute}\\s*=\\s*(\\w+)\\(self\\)`).exec(pythonClient)?.[1];
  return parts.length === 2 && cls !== undefined && hasDef(pythonClass(cls), method);
}

const goDir = join(repo, "packages", "sdk-go");
const goSource = readdirSync(goDir)
  .filter((file) => file.endsWith(".go") && !file.endsWith("_test.go"))
  .map((file) => read(join(goDir, file)))
  .join("\n");

function resolvesInGo(name: string): boolean {
  const parts = name.split(".");
  if (parts.length === 1) {
    return new RegExp(`^func (\\(\\w+ \\*Client\\) )?${name}\\(`, "m").test(goSource);
  }
  const [field, method] = parts;
  const type = new RegExp(`^\\s+${field}\\s+\\*(\\w+)`, "m").exec(goSource)?.[1];
  return (
    parts.length === 2 &&
    type !== undefined &&
    new RegExp(`^func \\(\\w+ \\*${type}\\) ${method}\\(`, "m").test(goSource)
  );
}

describe("capabilities.json and the Python and Go SDKs", () => {
  it("names methods the Python SDK has", () => {
    for (const c of capabilities) {
      for (const name of names(c, "python")) {
        expect(resolvesInPython(name), `${c.id}: the Python SDK has no ${name}`).toBe(true);
      }
    }
  });

  it("names methods the Go SDK has", () => {
    for (const c of capabilities) {
      for (const name of names(c, "go")) {
        expect(resolvesInGo(name), `${c.id}: the Go SDK has no ${name}`).toBe(true);
      }
    }
  });

  it("would notice a method that is not there", () => {
    expect(resolvesInSdk("endpoints.nope")).toBe(false);
    expect(resolvesInPython("endpoints.nope")).toBe(false);
    expect(resolvesInGo("Endpoints.Nope")).toBe(false);
  });
});
