import { describe, expect, it, vi } from "vitest";
// Next's own matcher, `has` check and value interpolation, so this test sees
// the rules the way the router applies them: for headers() every matching
// rule in order, the later one winning per header; for rewrites the first
// matching rule.
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import {
  compileNonPath,
  matchHas,
  prepareDestination,
} from "next/dist/shared/lib/router/utils/prepare-destination";
import { MAILHOOKS_FEATURES } from "./lib/mailhooks-features";
import { MARKDOWN_TWIN_HEADER } from "./lib/markdown-negotiation";
import nextConfig from "./next.config";

// next.config.ts reads the app URL from the environment when it is loaded.
const APP = process.env.NEXT_PUBLIC_APP_URL ?? "https://webhooks.cc";
const AUTH_MD = `<${APP}/auth.md>; rel="auth.md"`;
const API_CATALOG = `<${APP}/.well-known/api-catalog>; rel="api-catalog"`;

async function headersFor(pathname: string): Promise<Record<string, string>> {
  const rules = (await nextConfig.headers?.()) ?? [];
  const result: Record<string, string> = {};
  for (const rule of rules) {
    const params = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true })(pathname);
    if (!params) continue;
    const hasParams = Object.keys(params).length > 0;
    for (const { key, value } of rule.headers) {
      result[key.toLowerCase()] = hasParams ? compileNonPath(value, params) : value;
    }
  }
  return result;
}

describe("next.config.ts headers", () => {
  it.each([
    "/pricing",
    "/api/endpoints",
    "/.well-known/api-catalog",
    "/docs/agents.md",
    "/index.md",
  ])("advertises auth.md and the API catalog on %s", async (path) => {
    const headers = await headersFor(path);
    expect(headers.link).toBe(`${AUTH_MD}, ${API_CATALOG}`);
    expect(headers.vary).toBeUndefined();
  });

  it.each([
    ["/", "/index.md"],
    ["/docs", "/docs.md"],
    ["/docs/agents", "/docs/agents.md"],
    ["/docs/guides/test-stripe-webhooks", "/docs/guides/test-stripe-webhooks.md"],
  ])("links %s to its markdown twin %s and varies on Accept", async (path, twin) => {
    const headers = await headersFor(path);
    expect(headers.link).toBe(
      `${AUTH_MD}, ${API_CATALOG}, <${APP}${twin}>; rel="alternate"; type="text/markdown"`
    );
    expect(headers.vary).toBe("Accept");
  });

  it("keeps every relation on the deprecated auth.md v0.1 routes", async () => {
    for (const path of ["/api/agent/auth", "/api/agent/auth/claim"]) {
      const headers = await headersFor(path);
      expect(headers.link).toBe(`${AUTH_MD}, ${API_CATALOG}, <${APP}/auth.md>; rel="deprecation"`);
    }
  });
});

/** Where a beforeFiles rewrite sends a request, or null when none matches. */
async function rewriteFor(
  pathname: string,
  headers: Record<string, string> = {},
  config: typeof nextConfig = nextConfig
) {
  const rewrites = await config.rewrites?.();
  const beforeFiles = rewrites && !Array.isArray(rewrites) ? (rewrites.beforeFiles ?? []) : [];
  const req = { headers } as unknown as Parameters<typeof matchHas>[0];
  for (const rule of beforeFiles) {
    const params = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true })(pathname);
    if (!params) continue;
    const hasParams = rule.has || rule.missing ? matchHas(req, {}, rule.has, rule.missing) : {};
    if (!hasParams) continue;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: rule.destination,
      params: { ...params, ...hasParams },
      query: {},
    });
    return parsedDestination.pathname;
  }
  return null;
}

describe("next.config.ts markdown twin rewrites", () => {
  it.each([
    ["/docs/agents.md", "/docs.md/agents"],
    ["/docs/guides/test-stripe-webhooks.md", "/docs.md/guides/test-stripe-webhooks"],
    ["/docs/index.md", "/docs.md"],
    ["/docs/sdk/index.md", "/docs.md/sdk"],
  ])("serves %s from %s", async (path, twin) => {
    expect(await rewriteFor(path)).toBe(twin);
  });

  it.each([
    ["/", "/index.md"],
    ["/docs", "/docs.md"],
    ["/docs/agents", "/docs.md/agents"],
    ["/docs/sdk/testing/stripe-vitest", "/docs.md/sdk/testing/stripe-vitest"],
  ])("serves %s from %s when proxy.ts marked the request", async (path, twin) => {
    expect(await rewriteFor(path, { [MARKDOWN_TWIN_HEADER]: "1" })).toBe(twin);
    expect(await rewriteFor(path)).toBeNull();
  });

  it("leaves other pages alone, marked or not", async () => {
    for (const path of ["/pricing", "/auth.md", "/index.md", "/docs.md/agents"]) {
      expect(await rewriteFor(path, { [MARKDOWN_TWIN_HEADER]: "1" })).toBeNull();
    }
  });
});

describe("next.config.ts mailhooks.cc rewrites", () => {
  // The rewrites are built when next.config.ts loads, from NEXT_PUBLIC_MAILHOOKS_URL.
  async function mailConfig(): Promise<typeof nextConfig> {
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "https://mailhooks.cc");
    vi.resetModules();
    try {
      return (await import("./next.config")).default;
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it("serves every mailhooks.cc page from app/mailhooks on the mail host only", async () => {
    const config = await mailConfig();
    const paths = [
      "/pricing",
      "/parse",
      "/parse/shopify-orders",
      ...MAILHOOKS_FEATURES.map((f) => f.path),
    ];
    for (const path of paths) {
      expect(await rewriteFor(path, { host: "mailhooks.cc" }, config), path).toBe(
        `/mailhooks${path}`
      );
      expect(await rewriteFor(path, { host: "webhooks.cc" }, config), path).toBeNull();
    }
    expect(await rewriteFor("/", { host: "mailhooks.cc" }, config)).toBe("/mailhooks");
  });
});
