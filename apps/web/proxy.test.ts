import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.hoisted(() => vi.fn().mockResolvedValue({ data: { user: null }, error: null }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser },
  })),
}));

import { MAILHOOKS_FEATURES } from "./lib/mailhooks-features";
import { LAYOUT_TEMPLATES } from "./lib/layout-templates";
import { MAILHOOKS_PAGES } from "./lib/site";
import { config, proxy } from "./proxy";

beforeEach(() => {
  getUser.mockClear();
});

describe("proxy", () => {
  it("refuses POST requests with Next-Action and RSC headers before touching Supabase auth", async () => {
    const req = new NextRequest("https://webhooks.cc/", {
      method: "POST",
      headers: {
        "Next-Action": "cachefn",
        RSC: "1",
      },
    });
    const res = await proxy(req);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
    expect(getUser).not.toHaveBeenCalled();
  });

  it("refuses any request carrying Next-Action, including on /api routes", async () => {
    const req = new NextRequest("https://webhooks.cc/api/endpoints", {
      method: "POST",
      headers: {
        "next-action": "x",
      },
    });
    const res = await proxy(req);
    expect(res.status).toBe(404);
    expect(getUser).not.toHaveBeenCalled();
  });

  it("refuses POST requests to non-/api routes without Next-Action", async () => {
    const req = new NextRequest("https://webhooks.cc/not-a-route", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    const res = await proxy(req);
    expect(res.status).toBe(404);
    expect(getUser).not.toHaveBeenCalled();
  });

  it("lets POST requests to /api routes and GET requests to pages through", async () => {
    const apiPost = new NextRequest("https://webhooks.cc/api/go/endpoint", {
      method: "POST",
    });
    const apiRes = await proxy(apiPost);
    expect(apiRes.status).toBe(200);
    expect(getUser).toHaveBeenCalledTimes(1);

    const pageGet = new NextRequest("https://webhooks.cc/", {
      method: "GET",
    });
    const pageRes = await proxy(pageGet);
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("lets the email preview load images on every page, not only the dashboard", async () => {
    // A document keeps the policy of the page it was first loaded as, and
    // signing in moves to the dashboard without loading a new one.
    for (const path of ["/login", "/dashboard", "/account/plan"]) {
      const res = await proxy(new NextRequest(`https://webhooks.cc${path}`, { method: "GET" }));
      const csp = res.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toMatch(/img-src [^;]* https:(;|$)/);
      // Google's Drive picker opens in a pop-up of its own, never in a frame here.
      expect(csp).toContain("frame-src 'self';");
      expect(csp).not.toContain("google.com");
    }
  });
});

describe("proxy: markdown twins", () => {
  const BROWSER_ACCEPT =
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
  // NextResponse.next({ request: { headers } }) hands request headers on to
  // the router under this prefix, where the next.config.ts rewrite reads them.
  const MARKED = "x-middleware-request-x-markdown-twin";

  it.each(["/", "/docs", "/docs/agents"])(
    "marks %s for its markdown twin when an agent prefers markdown",
    async (path) => {
      const res = await proxy(
        new NextRequest(`https://webhooks.cc${path}`, { headers: { Accept: "text/markdown" } })
      );

      expect(res.headers.get(MARKED)).toBe("1");
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
      // The negotiated URL is the page's own, which stays indexable.
      expect(res.headers.get("X-Robots-Tag")).toBeNull();
      expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
      expect(getUser).not.toHaveBeenCalled();
    }
  );

  it("marks HEAD like GET", async () => {
    const res = await proxy(
      new NextRequest("https://webhooks.cc/", {
        method: "HEAD",
        headers: { Accept: "text/markdown" },
      })
    );
    expect(res.headers.get(MARKED)).toBe("1");
  });

  it("leaves browsers on the HTML page", async () => {
    const res = await proxy(
      new NextRequest("https://webhooks.cc/docs/agents", { headers: { Accept: BROWSER_ACCEPT } })
    );

    expect(res.headers.get(MARKED)).toBeNull();
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("drops a marker a client sent itself", async () => {
    const res = await proxy(
      new NextRequest("https://webhooks.cc/docs/agents", {
        headers: { Accept: BROWSER_ACCEPT, "x-markdown-twin": "1" },
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(MARKED)).toBeNull();
    expect(res.headers.get("x-middleware-override-headers") ?? "").not.toContain("x-markdown-twin");
  });

  it("serves the twins' own URLs without a session refresh and marks them noindex", async () => {
    for (const path of ["/index.md", "/docs.md", "/docs.md/agents", "/docs/sdk/api.md"]) {
      const res = await proxy(new NextRequest(`https://webhooks.cc${path}`));
      expect(res.headers.get(MARKED)).toBeNull();
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    }
    expect(getUser).not.toHaveBeenCalled();
  });
});

describe("proxy: remote MCP server", () => {
  it.each(["POST", "GET", "DELETE", "OPTIONS"])(
    "lets %s /mcp through without a session refresh",
    async (method) => {
      const res = await proxy(
        new NextRequest("https://webhooks.cc/mcp", {
          method,
          headers: { Authorization: "Bearer whcc_example" },
        })
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(getUser).not.toHaveBeenCalled();
    }
  );

  it("still refuses Server Action probes on /mcp and POSTs to look-alike paths", async () => {
    const probe = await proxy(
      new NextRequest("https://webhooks.cc/mcp", {
        method: "POST",
        headers: { "next-action": "x" },
      })
    );
    expect(probe.status).toBe(404);

    const lookAlike = await proxy(new NextRequest("https://webhooks.cc/mcpx", { method: "POST" }));
    expect(lookAlike.status).toBe(404);
  });

  it("keeps the OAuth consent page out of search results", async () => {
    const res = await proxy(new NextRequest("https://webhooks.cc/oauth/authorize"));
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });
});

describe("proxy: two sites", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://webhooks.cc");
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "https://mailhooks.cc");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves mailhooks.cc's own paths and marks the request's site", async () => {
    for (const path of [
      "/",
      "/pricing",
      "/parse/shopify-orders",
      ...MAILHOOKS_FEATURES.map((f) => f.path),
      "/dashboard",
      "/api/endpoints",
    ]) {
      const res = await proxy(new NextRequest(`https://mailhooks.cc${path}`));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-middleware-request-x-whk-site"), path).toBe("mailhooks");
    }
  });

  it("sends webhooks.cc's pages from mailhooks.cc to webhooks.cc", async () => {
    const res = await proxy(new NextRequest("https://mailhooks.cc/docs/layouts?x=1"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://webhooks.cc/docs/layouts?x=1");
  });

  it("marks a path neither site serves for mailhooks.cc's own 404, without a rewrite of its own", async () => {
    const res = await proxy(new NextRequest("https://mailhooks.cc/no-such-page/deeper"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    // An absolute rewrite made here can leave the server and loop (lib/site.ts).
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-whk-missing")).toBe("1");
    expect(res.headers.get("x-middleware-request-x-whk-site")).toBe("mailhooks");
  });

  it("marks an unknown sender, and anything below a page with nothing below it, as missing", async () => {
    for (const path of [
      "/parse/no-such-sender",
      "/parse/shopify-orders/extra",
      "/parse/%E0%A4%A",
      // Every page but /parse has nothing below it.
      ...MAILHOOKS_PAGES.filter((page) => page !== "/parse").map((page) => `${page}/extra`),
    ]) {
      const res = await proxy(new NextRequest(`https://mailhooks.cc${path}`));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-middleware-request-x-whk-missing"), path).toBe("1");
    }
    // Every page, every sender in the catalogue and the app's own paths are served as they are.
    for (const path of [
      ...MAILHOOKS_PAGES,
      ...LAYOUT_TEMPLATES.map((template) => `/parse/${template.id}`),
      "/dashboard/anything",
    ]) {
      const res = await proxy(new NextRequest(`https://mailhooks.cc${path}`));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-middleware-request-x-whk-missing"), path).toBeNull();
    }
  });

  it("lists the same pages as the feature catalogue", () => {
    expect([...MAILHOOKS_PAGES].sort()).toEqual(
      ["/pricing", "/parse", "/guides", ...MAILHOOKS_FEATURES.map((f) => f.path)].sort()
    );
  });

  it("sends app/mailhooks's own path to the page it stands for on mailhooks.cc", async () => {
    for (const [path, to] of [
      ["/mailhooks", "/"],
      ["/mailhooks/pricing?plan=business", "/pricing?plan=business"],
      // Where an unknown sender then gets mailhooks.cc's 404.
      ["/mailhooks/parse/no-such-sender", "/parse/no-such-sender"],
    ]) {
      const res = await proxy(new NextRequest(`https://mailhooks.cc${path}`));
      expect(res.status, path).toBe(307);
      expect(res.headers.get("location"), path).toBe(`https://mailhooks.cc${to}`);
    }
  });

  it("drops a missing marker a client sends, on either site", async () => {
    for (const url of ["https://mailhooks.cc/pricing", "https://webhooks.cc/docs"]) {
      const res = await proxy(new NextRequest(url, { headers: { "x-whk-missing": "1" } }));
      expect(res.status, url).toBe(200);
      expect(res.headers.get("x-middleware-request-x-whk-missing"), url).toBeNull();
      // The list of request headers Next keeps: it has the proxy's own and not the marker.
      const kept = res.headers.get("x-middleware-override-headers");
      expect(kept, url).toContain("x-whk-site");
      expect(kept, url).not.toContain("x-whk-missing");
    }
  });

  it("runs for every path except the ones the missing-page rewrite leaves out too", async () => {
    // next.config.ts repeats this lookahead; next.config.test.ts compares the two.
    expect(config.matcher).toHaveLength(1);
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    for (const path of ["/no-such-page", "/docs/agents", "/_next/data/x.json"]) {
      expect(matcher.test(path), path).toBe(true);
    }
    for (const path of [
      "/_next/static/chunks/a.js",
      "/_next/image",
      "/favicon.ico",
      "/robots.txt",
      "/sitemap.xml",
    ]) {
      expect(matcher.test(path), path).toBe(false);
    }
  });

  it("keeps mailhooks.cc's pages off webhooks.cc", async () => {
    const res = await proxy(new NextRequest("https://webhooks.cc/mailhooks/pricing?plan=business"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://mailhooks.cc/pricing?plan=business");
  });

  it("overwrites a site a client claims", async () => {
    const res = await proxy(
      new NextRequest("https://webhooks.cc/dashboard", { headers: { "x-whk-site": "mailhooks" } })
    );
    expect(res.headers.get("x-middleware-request-x-whk-site")).toBe("webhooks");
  });
});
