import { afterEach, describe, expect, it, vi } from "vitest";
import { nextFromRedirectTo, resolveRedirectBase, sanitizeNextPath } from "./auth-redirect";

describe("sanitizeNextPath", () => {
  it("passes a same-origin path through", () => {
    expect(sanitizeNextPath("/account")).toBe("/account");
    expect(sanitizeNextPath("/teams?x=1")).toBe("/teams?x=1");
  });

  it("falls back to /dashboard when missing", () => {
    expect(sanitizeNextPath(null)).toBe("/dashboard");
    expect(sanitizeNextPath("")).toBe("/dashboard");
  });

  it("honors a custom fallback", () => {
    expect(sanitizeNextPath(null, "/auth/reset-password")).toBe("/auth/reset-password");
  });

  it("rejects protocol-relative, absolute, and scheme URLs", () => {
    expect(sanitizeNextPath("//evil.com")).toBe("/dashboard");
    expect(sanitizeNextPath("https://evil.com")).toBe("/dashboard");
    expect(sanitizeNextPath("javascript:alert(1)")).toBe("/dashboard");
    expect(sanitizeNextPath("dashboard")).toBe("/dashboard");
    // Browsers read a backslash as a slash: "/\\evil" leaves the site.
    expect(sanitizeNextPath("/\\evil.example")).toBe("/dashboard");
    expect(sanitizeNextPath("/%5Cevil.example")).toBe("/%5Cevil.example");
    expect(sanitizeNextPath("/\tevil")).toBe("/dashboard");
    expect(sanitizeNextPath("/x\u0000")).toBe("/dashboard");
  });
});

describe("resolveRedirectBase", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function req(headers: Record<string, string> = {}) {
    return new Request("http://internal:3000/auth/confirm", { headers });
  }

  it("uses the request's own host in development even behind a proxy header", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(
      resolveRedirectBase(req({ "x-forwarded-host": "webhooks.cc" }), "http://localhost:3000")
    ).toBe("http://localhost:3000");
    expect(
      resolveRedirectBase(req({ host: "mailhooks.localhost:3000" }), "http://localhost:3000")
    ).toBe("http://mailhooks.localhost:3000");
  });

  it("answers with the forwarded host's site outside development", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://webhooks.cc");
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "https://mailhooks.cc");
    expect(
      resolveRedirectBase(req({ "x-forwarded-host": "webhooks.cc" }), "http://internal:3000")
    ).toBe("https://webhooks.cc");
    expect(
      resolveRedirectBase(req({ "x-forwarded-host": "mailhooks.cc" }), "http://internal:3000")
    ).toBe("https://mailhooks.cc");
  });

  it("follows the site the proxy settled over the forwarded headers", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://webhooks.cc");
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "https://mailhooks.cc");
    expect(
      resolveRedirectBase(
        req({ "x-whk-site": "mailhooks", "x-forwarded-host": "webhooks.cc" }),
        "http://internal:3000"
      )
    ).toBe("https://mailhooks.cc");
  });

  it("never answers with a host the request names that is not ours", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://webhooks.cc");
    expect(
      resolveRedirectBase(req({ "x-forwarded-host": "evil.example" }), "http://internal:3000")
    ).toBe("https://webhooks.cc");
  });

  it("reads Host when no forwarded host is present", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://webhooks.cc");
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "https://mailhooks.cc");
    expect(resolveRedirectBase(req({ host: "mailhooks.cc" }), "http://internal:3000")).toBe(
      "https://mailhooks.cc"
    );
    expect(resolveRedirectBase(req(), "https://webhooks.cc")).toBe("https://webhooks.cc");
  });
});

describe("nextFromRedirectTo", () => {
  const origins = ["https://webhooks.cc", "http://localhost:3000"];

  it("keeps path + query of a same-origin redirect", () => {
    expect(nextFromRedirectTo("https://webhooks.cc/cli/verify?code=ABCD", origins)).toBe(
      "/cli/verify?code=ABCD"
    );
    expect(nextFromRedirectTo("http://localhost:3000/agent/claim?t=1&u=2", origins)).toBe(
      "/agent/claim?t=1&u=2"
    );
  });

  it("falls back for GoTrue's default (bare site root)", () => {
    expect(nextFromRedirectTo("https://webhooks.cc", origins)).toBe("/dashboard");
    expect(nextFromRedirectTo("https://webhooks.cc/", origins)).toBe("/dashboard");
  });

  it("falls back for foreign origins, garbage, and missing values", () => {
    expect(nextFromRedirectTo("https://evil.com/cli/verify", origins)).toBe("/dashboard");
    expect(nextFromRedirectTo("https://webhooks.cc.evil.com/x", origins)).toBe("/dashboard");
    expect(nextFromRedirectTo("not a url", origins)).toBe("/dashboard");
    expect(nextFromRedirectTo(null, origins)).toBe("/dashboard");
    expect(nextFromRedirectTo("", origins, "/auth/reset-password")).toBe("/auth/reset-password");
  });
});
