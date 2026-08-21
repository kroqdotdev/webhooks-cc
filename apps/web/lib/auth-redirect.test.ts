import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRedirectBase, sanitizeNextPath } from "./auth-redirect";

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
