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
  });
});

describe("resolveRedirectBase", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function req(headers: Record<string, string> = {}) {
    return new Request("http://internal:3000/auth/confirm", { headers });
  }

  it("uses the request origin in development even behind a proxy header", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(
      resolveRedirectBase(req({ "x-forwarded-host": "webhooks.cc" }), "http://localhost:3000")
    ).toBe("http://localhost:3000");
  });

  it("prefers https://<x-forwarded-host> outside development", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(
      resolveRedirectBase(req({ "x-forwarded-host": "webhooks.cc" }), "http://internal:3000")
    ).toBe("https://webhooks.cc");
  });

  it("falls back to the origin when no forwarded host is present", () => {
    vi.stubEnv("NODE_ENV", "production");
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
