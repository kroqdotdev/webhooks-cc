import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.hoisted(() => vi.fn().mockResolvedValue({ data: { user: null }, error: null }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser },
  })),
}));

import { MAILHOOKS_FEATURES } from "./lib/mailhooks-features";
import { proxy } from "./proxy";

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

  it("allows Google's Drive picker on pages that lead to the dashboard, not only on it", async () => {
    // Signing in moves to the dashboard without loading a new document, so the
    // sign-in page's policy is the one the picker meets.
    for (const path of ["/login", "/dashboard", "/account/plan"]) {
      const res = await proxy(new NextRequest(`https://webhooks.cc${path}`, { method: "GET" }));
      const csp = res.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toMatch(/script-src [^;]*https:\/\/apis\.google\.com/);
      expect(csp).toContain("frame-src 'self' https://docs.google.com");
      // And the email preview's "Load images".
      expect(csp).toMatch(/img-src [^;]* https:(;|$)/);
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
