import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSite, servedOnMailhooks, siteForHost, siteOrigin } from "./site";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("siteForHost", () => {
  it("is webhooks for every host while one site is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "");
    expect(siteForHost("mailhooks.cc")).toBe("webhooks");
    expect(siteOrigin("mailhooks")).toBe(siteOrigin("webhooks"));
  });

  it("is mailhooks only for the configured mail host, on any port", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3210");
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "http://mailhooks.localhost:3210");
    expect(siteForHost("mailhooks.localhost:3210")).toBe("mailhooks");
    expect(siteForHost("MAILHOOKS.localhost")).toBe("mailhooks");
    expect(siteForHost("localhost:3210")).toBe("webhooks");
    expect(siteForHost("evil.mailhooks.localhost")).toBe("webhooks");
    expect(siteForHost(null)).toBe("webhooks");
    expect(siteOrigin("mailhooks")).toBe("http://mailhooks.localhost:3210");
  });
});

describe("parseSite", () => {
  it("reads only the two names", () => {
    expect(parseSite("mailhooks")).toBe("mailhooks");
    expect(parseSite("other")).toBe("webhooks");
    expect(parseSite(null)).toBe("webhooks");
  });
});

describe("servedOnMailhooks", () => {
  it("keeps mailhooks.cc's pages, the app and the API, and sends the rest away", () => {
    for (const path of [
      "/",
      "/pricing",
      "/parse/x",
      "/login",
      "/auth/confirm",
      "/dashboard",
      "/account/plan",
      "/teams/1",
      "/api/endpoints",
      "/s/token",
      "/icon-192.png",
    ]) {
      expect(servedOnMailhooks(path), path).toBe(true);
    }
    for (const path of [
      "/docs",
      "/docs/layouts",
      "/blog",
      "/compare",
      "/privacy",
      "/cli/verify",
      "/oauth/authorize",
      "/mcp",
      "/parsex",
      "/accounts",
    ]) {
      expect(servedOnMailhooks(path), path).toBe(false);
    }
  });
});
