import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.hoisted(() => vi.fn().mockResolvedValue({ data: { user: null }, error: null }));

const createServerClient = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => { auth: { getUser: () => Promise<unknown> } }>(() => ({
    auth: { getUser },
  }))
);

vi.mock("@supabase/ssr", () => ({ createServerClient }));

import { MAILHOOKS_FEATURES } from "./lib/mailhooks-features";
import { LAYOUT_TEMPLATES } from "./lib/layout-templates";
import { MAILHOOKS_PAGES } from "./lib/site";
import { config, proxy } from "./proxy";

beforeEach(() => {
  getUser.mockClear();
  createServerClient.mockClear();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://api1.webhooks.cc");
  vi.stubEnv("SUPABASE_URL", "http://gateway:8000");
});

afterEach(() => vi.unstubAllEnvs());

/** What a browser sends when it loads a page into its window. */
const PAGE_LOAD = {
  "sec-fetch-dest": "document",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

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
    expect(getUser).not.toHaveBeenCalled();

    const pageGet = new NextRequest("https://webhooks.cc/", {
      method: "GET",
      headers: PAGE_LOAD,
    });
    const pageRes = await proxy(pageGet);
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("lets the email preview load images on every page, not only the dashboard", async () => {
    // A document keeps the policy of the page it was first loaded as, and
    // signing in moves to the dashboard without loading a new one.
    for (const path of ["/login", "/dashboard", "/account/plan"]) {
      const res = await proxy(new NextRequest(`https://webhooks.cc${path}`, { method: "GET" }));
      const csp = res.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toMatch(/img-src [^;]* https:(;|$)/);
      // Google's Drive picker opens in a pop-up of its own, never in a frame here.
      expect(csp).toContain("frame-src 'self' https://challenges.cloudflare.com;");
      expect(csp).not.toContain("google.com");
    }
  });
});

describe("proxy: session check", () => {
  it("checks the session when a page loads into the window", async () => {
    await proxy(new NextRequest("https://webhooks.cc/dashboard", { headers: PAGE_LOAD }));
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("checks it for a browser without Sec-Fetch-Dest that asks for HTML", async () => {
    await proxy(
      new NextRequest("https://webhooks.cc/dashboard", {
        headers: { accept: PAGE_LOAD.accept },
      })
    );
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("leaves client navigations, prefetches and router.refresh() alone", async () => {
    // Next makes them with fetch() and strips its RSC headers before the
    // proxy runs, so all the proxy sees is a fetch.
    for (const path of ["/dashboard?endpoint=abc", "/docs", "/"]) {
      await proxy(
        new NextRequest(`https://webhooks.cc${path}`, {
          headers: { "sec-fetch-dest": "empty", accept: "*/*" },
        })
      );
    }
    expect(getUser).not.toHaveBeenCalled();
  });

  it("lets Sec-Fetch-Dest decide before Accept", async () => {
    // A fetch that asks for HTML, a frame and a HEAD are no page loads.
    for (const init of [
      { headers: { "sec-fetch-dest": "empty", accept: PAGE_LOAD.accept } },
      { headers: { "sec-fetch-dest": "iframe", accept: PAGE_LOAD.accept } },
      { method: "HEAD", headers: PAGE_LOAD },
    ]) {
      await proxy(new NextRequest("https://webhooks.cc/dashboard", init));
    }
    expect(getUser).not.toHaveBeenCalled();
  });

  it("leaves API routes alone, even opened as a page", async () => {
    for (const [path, init] of [
      ["/api/endpoints", { headers: { authorization: "Bearer x", "sec-fetch-dest": "empty" } }],
      ["/api/endpoints", { headers: PAGE_LOAD }],
      ["/api", { headers: PAGE_LOAD }],
      ["/api/auth/device-request", { method: "POST", headers: { "sec-fetch-dest": "empty" } }],
    ] as const) {
      await proxy(new NextRequest(`https://webhooks.cc${path}`, init));
    }
    expect(getUser).not.toHaveBeenCalled();
  });

  it("leaves the auth handoff routes, which set their own cookies, alone", async () => {
    for (const path of [
      "/auth/callback?code=x",
      "/auth/confirm?token_hash=x",
      "/auth/switch/finish",
    ]) {
      await proxy(new NextRequest(`https://webhooks.cc${path}`, { headers: PAGE_LOAD }));
    }
    expect(getUser).not.toHaveBeenCalled();
  });

  it("checks over the internal address under the public address's cookie name", async () => {
    await proxy(new NextRequest("https://webhooks.cc/dashboard", { headers: PAGE_LOAD }));
    const [url, , options] = createServerClient.mock.calls[0] as [
      string,
      string,
      { cookieOptions?: { name?: string } },
    ];
    expect(url).toBe("http://gateway:8000");
    expect(options.cookieOptions?.name).toBe("sb-api1-auth-token");
  });

  it("keeps a response that sets session cookies out of caches, however often it sets them", async () => {
    type SetAll = (
      cookies: { name: string; value: string; options: object }[],
      headers: Record<string, string>
    ) => void;
    createServerClient.mockImplementationOnce((...args: unknown[]) => {
      const { setAll } = (args[2] as { cookies: { setAll: SetAll } }).cookies;
      return {
        auth: {
          getUser: async () => {
            // A refresh, then a refused session: @supabase/ssr hands the
            // headers over with the first call only.
            setAll([{ name: "sb-api1-auth-token", value: "refreshed", options: {} }], {
              "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
            });
            setAll([{ name: "sb-api1-auth-token", value: "", options: { maxAge: 0 } }], {});
            return { data: { user: null }, error: null };
          },
        },
      };
    });
    const res = await proxy(
      new NextRequest("https://webhooks.cc/dashboard", { headers: PAGE_LOAD })
    );
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("set-cookie")).toMatch(/^sb-api1-auth-token=;/);
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

  it("answers an API path with a malformed id 404 in JSON, before any route", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await proxy(
        new NextRequest("https://webhooks.cc/api/requests/nope", {
          method,
        })
      );
      expect(res.status, method).toBe(404);
      expect(await res.json(), method).toMatchObject({ error: "not_found" });
    }
    const ok = await proxy(
      new NextRequest("https://webhooks.cc/api/requests/0b9f6a52-3f43-4c47-9a83-2f7d8a1c5e10")
    );
    expect(ok.status).toBe(200);
  });

  it("sends webhooks.cc's pages from mailhooks.cc to webhooks.cc", async () => {
    const res = await proxy(new NextRequest("https://mailhooks.cc/blog/some-post?x=1"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://webhooks.cc/blog/some-post?x=1");
  });

  it("serves the docs on mailhooks.cc itself", async () => {
    for (const path of ["/docs", "/docs/layouts", "/docs/sdk/testing"]) {
      const res = await proxy(new NextRequest(`https://mailhooks.cc${path}`));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location"), path).toBeNull();
      expect(res.headers.get("x-middleware-request-x-whk-site"), path).toBe("mailhooks");
      expect(res.headers.get("x-middleware-request-x-whk-missing"), path).toBeNull();
    }
  });

  it("marks a doc that does not exist for mailhooks.cc's own 404, not webhooks.cc's", async () => {
    for (const path of ["/docs/no-such-doc", "/docs/sdk/no-such-doc", "/docs/layouts/extra"]) {
      const res = await proxy(new NextRequest(`https://mailhooks.cc${path}`));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-middleware-request-x-whk-missing"), path).toBe("1");
    }
    // Markdown twins have their own route; webhooks.cc answers its own 404.
    for (const url of ["https://mailhooks.cc/docs/layouts.md", "https://webhooks.cc/docs/nope"]) {
      const res = await proxy(new NextRequest(url));
      expect(res.headers.get("x-middleware-request-x-whk-missing"), url).toBeNull();
    }
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

  it("never sends a /mailhooks path to another host", async () => {
    for (const path of [
      "/mailhooks//evil.example/x",
      "/mailhooks/%2F%2Fevil.example",
      "/mailhooks/\\evil.example",
      "/mailhooks///evil.example?q=1",
    ]) {
      const res = await proxy(new NextRequest(`https://mailhooks.cc${path}`));
      expect(res.status, path).toBe(307);
      expect(new URL(res.headers.get("location")!).origin, path).toBe("https://mailhooks.cc");
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
