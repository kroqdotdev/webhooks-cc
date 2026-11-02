import { afterEach, describe, expect, it, vi } from "vitest";
import {
  endpointHomeSite,
  isEndpointSite,
  listedOn,
  otherSite,
  parseSite,
  servedOnMailhooks,
  siteForHost,
  siteOrigin,
} from "./site";

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

describe("endpoint sites", () => {
  it("lists an endpoint on its own site and on both, once there are two sites", () => {
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "http://mailhooks.localhost:3210");
    expect(listedOn("webhooks", "webhooks")).toBe(true);
    expect(listedOn("webhooks", "mailhooks")).toBe(false);
    expect(listedOn("mailhooks", "mailhooks")).toBe(true);
    expect(listedOn("mailhooks", "webhooks")).toBe(false);
    expect(listedOn("both", "mailhooks")).toBe(true);
    // An older client's copy without a site is listed everywhere.
    expect(listedOn(undefined, "mailhooks")).toBe(true);
  });

  it("lists every endpoint while one site is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "");
    expect(listedOn("mailhooks", "webhooks")).toBe(true);
  });

  it("reads only the three values", () => {
    expect(["webhooks", "mailhooks", "both"].every(isEndpointSite)).toBe(true);
    expect(isEndpointSite("Both")).toBe(false);
    expect(isEndpointSite(null)).toBe(false);
  });

  it("sends an endpoint's links to its own site, or this one when it is on both", () => {
    expect(endpointHomeSite("mailhooks", "webhooks")).toBe("mailhooks");
    expect(endpointHomeSite("both", "mailhooks")).toBe("mailhooks");
    expect(endpointHomeSite(undefined, "webhooks")).toBe("webhooks");
    expect(otherSite("webhooks")).toBe("mailhooks");
    expect(otherSite("mailhooks")).toBe("webhooks");
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

describe("homeOrigin", () => {
  it("is the account's site's origin, webhooks.cc for anything else", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://webhooks.cc");
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "https://mailhooks.cc");
    const { homeOrigin } = await import("./supabase/home-site");
    expect(homeOrigin("mailhooks")).toBe("https://mailhooks.cc");
    expect(homeOrigin("webhooks")).toBe("https://webhooks.cc");
    expect(homeOrigin(null)).toBe("https://webhooks.cc");
  });
});
