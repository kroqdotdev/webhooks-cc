import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { WebhooksCC } from "../client";

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
  local: Record<Surface, Record<string, string>>;
}

const manifest = JSON.parse(read(join(repo, "capabilities.json"))) as Manifest;
const capabilities = manifest.capabilities;

/** The names a surface lists, or [] when it gives a reason instead. */
const names = (c: Capability, surface: Surface): string[] =>
  Array.isArray(c[surface]) ? (c[surface] as string[]) : [];

/** Every name the file gives for a surface, with where it is listed. */
const listed = (surface: Surface) => [
  ...capabilities.flatMap((c) => names(c, surface).map((name) => ({ id: c.id, name }))),
  ...Object.keys(manifest.local[surface] ?? {}).map((name) => ({ id: `local.${surface}`, name })),
];

/** Fails on a listed name the client lacks, and on a client name not listed. */
function expectSameNames(surface: Surface, label: string, actual: Set<string>) {
  for (const { id, name } of listed(surface)) {
    expect(actual.has(name), `${id}: the ${label} has no ${name}`).toBe(true);
  }
  const all = new Set(listed(surface).map(({ name }) => name));
  const missing = [...actual].filter((name) => !all.has(name)).sort();
  expect(
    missing,
    `add these ${label} names to a capability in capabilities.json (or to local.${surface})`
  ).toEqual([]);
}

// ─── API routes ─────────────────────────────────────────────────────────

const apiDir = join(repo, "apps", "web", "app", "api");
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return entry === "route.ts" ? [path] : [];
  });
}

/** The HTTP methods a route file exports, declared or re-exported. */
function handlers(source: string): string[] {
  const declared = [
    ...source.matchAll(/export\s+(?:async\s+)?(?:function\s+|const\s+|let\s+)([A-Z]+)\b/g),
  ].map((m) => m[1]);
  const reexported = [...source.matchAll(/export\s*\{([^}]*)\}/g)].flatMap((m) =>
    m[1].split(",").map(
      (part) =>
        part
          .trim()
          .split(/\s+as\s+/)
          .pop() ?? ""
    )
  );
  return [...declared, ...reexported].filter((name) => METHODS.has(name));
}

/** "METHOD /api/path" for every handler, with the file that serves it. */
const routes = new Map<string, string>();
for (const file of routeFiles(apiDir)) {
  const path = "/api/" + relative(apiDir, file).split(sep).slice(0, -1).join("/");
  const source = read(file);
  for (const method of handlers(source)) {
    routes.set(`${method} ${path.replace(/\/$/, "")}`, source);
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

// Session-only is read per file: a file that mixed both kinds of handler
// would need a smarter check, and the test below refuses one.
const SESSION_AUTH = /authenticateSessionRequest\(|domainAccount\(/;
const KEY_AUTH = /authenticateRequest(?:RequireUser)?\(/;

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
    expect(routes.size).toBeGreaterThan(100);
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
        const source = routes.get(route) ?? "";
        expect(
          SESSION_AUTH.test(source) && KEY_AUTH.test(source),
          `${route}: its file has handlers of both kinds, which this check cannot tell apart`
        ).toBe(false);
        expect(
          SESSION_AUTH.test(source),
          c.sessionOnly
            ? `${c.id}: ${route} takes API keys, but the capability says sessionOnly`
            : `${c.id}: ${route} takes only a session; say why in sessionOnly`
        ).toBe(Boolean(c.sessionOnly));
      }
    }
  });
});

// ─── TypeScript SDK ─────────────────────────────────────────────────────

const clientSource = read(join(__dirname, "..", "client.ts"));
const privateMembers = new Set(
  [...clientSource.matchAll(/^ {2}(?:private|protected)\s+(?:readonly\s+|async\s+)*(\w+)/gm)].map(
    (m) => m[1]
  )
);

/** The client's public calls: namespaces, methods, and static constructors. */
function sdkNames(): Set<string> {
  const client = new WebhooksCC({ apiKey: "whcc_capabilities" });
  const out = new Set<string>();
  const walk = (value: object, prefix: string) => {
    for (const [key, member] of Object.entries(value)) {
      if (!prefix && privateMembers.has(key)) continue;
      if (typeof member === "function") out.add(prefix + key);
      else if (member && typeof member === "object" && !Array.isArray(member)) {
        walk(member as object, `${prefix}${key}.`);
      }
    }
  };
  walk(client, "");
  for (const key of Object.getOwnPropertyNames(WebhooksCC.prototype)) {
    if (key !== "constructor" && !privateMembers.has(key)) out.add(key);
  }
  for (const key of Object.getOwnPropertyNames(WebhooksCC)) {
    if (typeof (WebhooksCC as unknown as Record<string, unknown>)[key] === "function") {
      out.add(`WebhooksCC.${key}`);
    }
  }
  return out;
}

// ─── Python SDK ─────────────────────────────────────────────────────────

const pythonDir = join(repo, "packages", "sdk-python", "src", "webhooks_cc");
const pythonModules = readdirSync(pythonDir)
  .filter((file) => file.endsWith(".py"))
  .map((file) => read(join(pythonDir, file)));

/** A class's body: its indented lines, up to the next unindented one. */
function classBody(sources: string[], header: RegExp): string {
  for (const source of sources) {
    const start = source.search(header);
    if (start < 0) continue;
    const rest = source.slice(source.indexOf("\n", start) + 1);
    const end = rest.search(/^\S/m);
    return end < 0 ? rest : rest.slice(0, end);
  }
  throw new Error(`no ${header}`);
}

/** WebhooksCC's public methods and those of the resources it hangs off itself. */
function pythonNames(): Set<string> {
  const methods = (cls: string) =>
    [
      ...classBody(pythonModules, new RegExp(`^class ${cls}\\b`, "m")).matchAll(
        /^ {4}(?:async\s+)?def ([a-z]\w*)\(/gm
      ),
    ].map((m) => m[1]);
  const client = classBody(pythonModules, /^class WebhooksCC\b/m);
  const out = new Set(methods("WebhooksCC"));
  for (const [, attribute, cls] of client.matchAll(/self\.(\w+)\s*=\s*([A-Z]\w*)\(self\)/g)) {
    for (const method of methods(cls)) out.add(`${attribute}.${method}`);
  }
  return out;
}

// ─── Go SDK ─────────────────────────────────────────────────────────────

const goDir = join(repo, "packages", "sdk-go");
const goSource = readdirSync(goDir)
  .filter((file) => file.endsWith(".go") && !file.endsWith("_test.go"))
  .map((file) => read(join(goDir, file)))
  .join("\n");

/** Client's exported methods, its services' (Endpoints.Create), and New* constructors. */
function goNames(): Set<string> {
  const methodsOf = (type: string) =>
    [...goSource.matchAll(new RegExp(`^func \\(\\w+ \\*?${type}\\) ([A-Z]\\w*)\\(`, "gm"))].map(
      (m) => m[1]
    );
  const client = classBody([goSource], /^type Client struct \{/m);
  const out = new Set(methodsOf("Client"));
  for (const [, field, type] of client.matchAll(/^\s+([A-Z]\w*)\s+\*(\w+)\s*$/gm)) {
    for (const method of methodsOf(type)) out.add(`${field}.${method}`);
  }
  for (const [, name] of goSource.matchAll(/^func (New\w*)\(/gm)) out.add(name);
  return out;
}

describe("capabilities.json and the SDKs", () => {
  it("matches the TypeScript SDK's client", () => {
    expectSameNames("sdk", "TypeScript SDK", sdkNames());
  });

  it("matches the Python SDK's client", () => {
    expectSameNames("python", "Python SDK", pythonNames());
  });

  it("matches the Go SDK's client", () => {
    expectSameNames("go", "Go SDK", goNames());
  });

  it("reads each SDK's client", () => {
    expect(sdkNames()).toContain("endpoints.create");
    expect(sdkNames()).toContain("WebhooksCC.sandbox");
    expect(sdkNames()).not.toContain("request");
    expect(pythonNames()).toContain("endpoints.create");
    expect(pythonNames()).not.toContain("endpoints.__init__");
    expect(goNames()).toContain("Endpoints.Create");
    expect(goNames()).toContain("NewSandbox");
  });
});
