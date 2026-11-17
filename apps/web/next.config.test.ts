import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// Next's own matcher, `has` check and value interpolation, so this test sees
// the rules the way the router applies them: for headers() every matching
// rule in order, the later one winning per header; for rewrites the first
// matching rule.
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { modifyRouteRegex } from "next/dist/lib/redirect-status";
import {
  compileNonPath,
  matchHas,
  prepareDestination,
} from "next/dist/shared/lib/router/utils/prepare-destination";
import { MAILHOOKS_MISSING_HEADER, MAILHOOKS_PAGES } from "./lib/site";
import { MARKDOWN_TWIN_HEADER } from "./lib/markdown-negotiation";
import { ROUTER_STATE_HEADER, ROUTER_STATE_REFUSED_PATH } from "./lib/router-state-header";
import nextConfig from "./next.config";

// next.config.ts reads the app URL from the environment when it is loaded.
const APP = process.env.NEXT_PUBLIC_APP_URL ?? "https://webhooks.cc";
const AUTH_MD = `<${APP}/auth.md>; rel="auth.md"`;
const API_CATALOG = `<${APP}/.well-known/api-catalog>; rel="api-catalog"`;

async function headersFor(
  pathname: string,
  requestHeaders: Record<string, string> = {}
): Promise<Record<string, string>> {
  const rules = (await nextConfig.headers?.()) ?? [];
  const req = { headers: requestHeaders } as unknown as Parameters<typeof matchHas>[0];
  const result: Record<string, string> = {};
  for (const rule of rules) {
    // The router compiles header sources with modifyRouteRegex, which lets
    // "/:path*" match the root and a trailing slash.
    const params = getPathMatch(rule.source, {
      strict: true,
      removeUnnamedParams: true,
      regexModifier: (regex) => modifyRouteRegex(regex),
    })(pathname);
    if (!params) continue;
    if ((rule.has || rule.missing) && !matchHas(req, {}, rule.has, rule.missing)) continue;
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

  // The router's RSC fetches of a prerendered page share one `_rsc` URL across
  // builds, and Next marks them stale-while-revalidate for a year: Chromium
  // then served the previous build's payload after a deploy, whose chunks left
  // old module factories behind (React error #306 on the landing page).
  it.each(["/", "/dashboard", "/docs/agents", "/webhooks/stripe"])(
    "keeps the RSC payload of %s out of the browser's HTTP cache",
    async (path) => {
      // A navigation, and the segment cache's route tree prefetch (the one that
      // brought in the stale payload).
      const requests: Record<string, string>[] = [
        {},
        { "next-router-prefetch": "1", "next-router-segment-prefetch": "/_tree" },
      ];
      for (const prefetch of requests) {
        const headers = await headersFor(path, { rsc: "1", ...prefetch });
        expect(headers["cache-control"]).toBe(
          "private, no-cache, no-store, max-age=0, must-revalidate"
        );
      }
    }
  );

  it("leaves Cache-Control to Next for a page's HTML", async () => {
    for (const path of ["/", "/dashboard", "/docs/agents"]) {
      expect((await headersFor(path))["cache-control"]).toBeUndefined();
    }
    expect((await headersFor("/email-templates/invite.html"))["cache-control"]).toBe(
      "public, max-age=0, no-transform"
    );
  });

  it("keeps every relation on the deprecated auth.md v0.1 routes", async () => {
    for (const path of ["/api/agent/auth", "/api/agent/auth/claim"]) {
      const headers = await headersFor(path);
      expect(headers.link).toBe(`${AUTH_MD}, ${API_CATALOG}, <${APP}/auth.md>; rel="deprecation"`);
    }
  });
});

/**
 * Where the beforeFiles rewrites send a request, or null when none matches.
 * They chain as in Next's router (resolve-routes.js; only afterFiles and
 * fallback rewrites stop at a file): each rule is matched against the path
 * the rules before it rewrote to.
 */
async function rewriteFor(
  pathname: string,
  headers: Record<string, string> = {},
  config: typeof nextConfig = nextConfig
) {
  const rewrites = await config.rewrites?.();
  const beforeFiles = rewrites && !Array.isArray(rewrites) ? (rewrites.beforeFiles ?? []) : [];
  const req = { headers } as unknown as Parameters<typeof matchHas>[0];
  let current = pathname;
  let rewritten = false;
  for (const rule of beforeFiles) {
    const params = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true })(current);
    if (!params) continue;
    const hasParams = rule.has || rule.missing ? matchHas(req, {}, rule.has, rule.missing) : {};
    if (!hasParams) continue;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: rule.destination,
      params: { ...params, ...hasParams },
      query: {},
    });
    current = parsedDestination.pathname ?? current;
    rewritten = true;
  }
  return rewritten ? current : null;
}

describe("next.config.ts router state rewrite", () => {
  const tree = encodeURIComponent(
    JSON.stringify(["", { children: ["dashboard", { children: ["__PAGE__", {}] }] }])
  );

  it("sends an RSC request with a malformed router state header to the 400 route, on any page and host", async () => {
    for (const path of ["/", "/dashboard", "/docs/agents", "/endpoints/abc123"]) {
      for (const host of ["webhooks.cc", "mailhooks.cc"]) {
        expect(
          await rewriteFor(path, { host, rsc: "1", [ROUTER_STATE_HEADER]: "%7Bnot-json" })
        ).toBe(ROUTER_STATE_REFUSED_PATH);
      }
    }
  });

  it("leaves a header Next's client writes alone", async () => {
    expect(await rewriteFor("/dashboard", { rsc: "1", [ROUTER_STATE_HEADER]: tree })).toBeNull();
  });

  it("leaves requests Next does not read the header on alone", async () => {
    // Next validates the header only on RSC requests (RSC: 1).
    expect(await rewriteFor("/dashboard", { [ROUTER_STATE_HEADER]: "%7Bnot-json" })).toBeNull();
    expect(
      await rewriteFor("/dashboard", { rsc: "2", [ROUTER_STATE_HEADER]: "%7Bnot-json" })
    ).toBeNull();
    expect(await rewriteFor("/dashboard", { rsc: "1" })).toBeNull();
  });
});

describe("next.config.ts agent skills rewrite", () => {
  it("serves the index at the directory URL, which Next reaches without its trailing slash", async () => {
    expect(await rewriteFor("/.well-known/agent-skills")).toBe(
      "/.well-known/agent-skills/index.json"
    );
  });
});

describe("next.config.ts markdown twin rewrites", () => {
  it.each([
    ["/docs/agents.md", "/docs.md/agents"],
    ["/docs/guides/test-stripe-webhooks.md", "/docs.md/guides/test-stripe-webhooks"],
    ["/docs/index.md", "/docs.md"],
    ["/docs/sdk/index.md", "/docs.md/sdk"],
    ["/share/vite.md", "/share.md/vite"],
  ])("serves %s from %s", async (path, twin) => {
    expect(await rewriteFor(path)).toBe(twin);
  });

  it.each([
    ["/", "/index.md"],
    ["/docs", "/docs.md"],
    ["/docs/agents", "/docs.md/agents"],
    ["/docs/sdk/testing/stripe-vitest", "/docs.md/sdk/testing/stripe-vitest"],
    ["/share/vite", "/share.md/vite"],
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

  it("refuses after the mailhooks.cc rewrites, which would otherwise render mailhooks.cc's 404", async () => {
    // proxy.ts marks a path mailhooks.cc does not serve; a later rule would
    // rewrite the refusal to /mailhooks/missing, which renders the page.
    const config = await mailConfig();
    expect(
      await rewriteFor(
        "/wp-admin",
        {
          host: "mailhooks.cc",
          [MAILHOOKS_MISSING_HEADER]: "1",
          rsc: "1",
          [ROUTER_STATE_HEADER]: "%7Bnot-json",
        },
        config
      )
    ).toBe(ROUTER_STATE_REFUSED_PATH);
    expect(
      await rewriteFor(
        "/docs/agents",
        {
          host: "mailhooks.cc",
          accept: "text/markdown",
          [MARKDOWN_TWIN_HEADER]: "1",
          rsc: "1",
          [ROUTER_STATE_HEADER]: "%7Bnot-json",
        },
        config
      )
    ).toBe(ROUTER_STATE_REFUSED_PATH);
    // The same requests with a header Next's client writes keep their rewrites.
    const tree = encodeURIComponent(JSON.stringify(["", {}]));
    expect(
      await rewriteFor(
        "/docs/agents",
        { host: "mailhooks.cc", rsc: "1", [ROUTER_STATE_HEADER]: tree },
        config
      )
    ).toBe("/mailhooks/docs/agents");
  });

  it("serves every mailhooks.cc page from app/mailhooks on the mail host only", async () => {
    const config = await mailConfig();
    // lib/site.ts's list is what proxy.ts goes by; every page on it has a rewrite here.
    const paths = [...MAILHOOKS_PAGES, "/parse/shopify-orders"];
    for (const path of paths) {
      expect(await rewriteFor(path, { host: "mailhooks.cc" }, config), path).toBe(
        `/mailhooks${path}`
      );
      expect(await rewriteFor(path, { host: "webhooks.cc" }, config), path).toBeNull();
    }
    expect(await rewriteFor("/", { host: "mailhooks.cc" }, config)).toBe("/mailhooks");
  });

  it("serves the docs on the mail host from app/mailhooks/docs", async () => {
    const config = await mailConfig();
    const mail = { host: "mailhooks.cc" };
    expect(await rewriteFor("/docs", mail, config)).toBe("/mailhooks/docs");
    expect(await rewriteFor("/docs/layouts", mail, config)).toBe("/mailhooks/docs/layouts");
    expect(await rewriteFor("/docs/sdk/testing/stripe-vitest", mail, config)).toBe(
      "/mailhooks/docs/sdk/testing/stripe-vitest"
    );
    // webhooks.cc's docs are app/docs itself.
    expect(await rewriteFor("/docs/layouts", { host: "webhooks.cc" }, config)).toBeNull();
  });

  it("gives an agent on the mail host the same markdown twin as on webhooks.cc", async () => {
    const config = await mailConfig();
    const mail = { host: "mailhooks.cc" };
    expect(await rewriteFor("/docs/layouts.md", mail, config)).toBe("/docs.md/layouts");
    expect(
      await rewriteFor("/docs/layouts", { ...mail, [MARKDOWN_TWIN_HEADER]: "1" }, config)
    ).toBe("/docs.md/layouts");
    expect(await rewriteFor("/docs", { ...mail, [MARKDOWN_TWIN_HEADER]: "1" }, config)).toBe(
      "/docs.md"
    );
  });

  it("serves mailhooks.cc's own 404 only for a path the proxy marked on the mail host", async () => {
    const config = await mailConfig();
    const marked = { host: "mailhooks.cc", "x-whk-missing": "1" };
    expect(await rewriteFor("/no-such-page", marked, config)).toBe("/mailhooks/missing");
    expect(await rewriteFor("/no/such/page", marked, config)).toBe("/mailhooks/missing");
    // Not without the marker, and never on webhooks.cc.
    expect(await rewriteFor("/no-such-page", { host: "mailhooks.cc" }, config)).toBeNull();
    expect(
      await rewriteFor("/no-such-page", { host: "webhooks.cc", "x-whk-missing": "1" }, config)
    ).toBeNull();
    // Not on the paths proxy.ts never runs for: a marker there is the client's own.
    for (const path of [
      "/_next/static/chunks/app.js",
      "/_next/image",
      "/favicon.ico",
      "/robots.txt",
      "/sitemap.xml",
      "/sitemap.txt",
      "/sitemap.rss",
    ]) {
      const to = await rewriteFor(path, marked, config);
      expect(to, path).not.toBe("/mailhooks/missing");
    }
  });

  it("leaves out exactly the paths the proxy's matcher leaves out", async () => {
    const config = await mailConfig();
    const rewrites = await config.rewrites?.();
    const beforeFiles = rewrites && !Array.isArray(rewrites) ? (rewrites.beforeFiles ?? []) : [];
    const rule = beforeFiles.find((entry) => entry.destination === "/mailhooks/missing");
    // proxy.ts's matcher has to be a literal there, so it is read as text
    // (written as in the source, with its doubled backslashes).
    const proxySource = readFileSync(new URL("./proxy.ts", import.meta.url), "utf8");
    const lookahead = /"\/\((\(\?!.*\))\.\*\)"/.exec(proxySource)?.[1];
    expect(lookahead).toBeTruthy();
    expect(rule?.source).toBe(`/:path(${lookahead!.replaceAll("\\\\", "\\")}.*)`);
  });
});

describe("next.config.ts redirects", () => {
  it("sends /docs/providers/<provider> to the provider's page", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    const rule = redirects.find((r) => r.source === "/docs/providers/:provider");
    expect(rule?.destination).toBe("/webhooks/:provider");
  });

  it("serves /pricing as a page of its own, not a redirect to the landing page", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    const matching = redirects.filter((rule) =>
      getPathMatch(rule.source, { strict: true, removeUnnamedParams: true })("/pricing")
    );
    expect(matching).toEqual([]);
  });
});
