import { afterEach, describe, expect, it, vi } from "vitest";

const verifyOtp = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp } }),
}));

import { GET } from "./route";

function link(host: string, redirectTo: string) {
  const params = new URLSearchParams({
    token_hash: "hash",
    type: "email",
    next: "/dashboard",
    redirect_to: redirectTo,
  });
  return new Request(`http://internal:3000/auth/confirm?${params}`, { headers: { host } });
}

describe("GET /auth/confirm on two sites", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    verifyOtp.mockReset();
  });

  function twoSites() {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://webhooks.cc");
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "https://mailhooks.cc");
  }

  it("sends a link asked for on mailhooks.cc to be verified there", async () => {
    twoSites();
    const response = await GET(link("webhooks.cc", "https://mailhooks.cc/dashboard"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://mailhooks.cc");
    expect(location.pathname).toBe("/auth/confirm");
    expect(location.searchParams.get("token_hash")).toBe("hash");
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("verifies on mailhooks.cc and lands there", async () => {
    twoSites();
    verifyOtp.mockResolvedValue({ error: null });
    const response = await GET(link("mailhooks.cc", "https://mailhooks.cc/dashboard?template=x"));
    expect(verifyOtp).toHaveBeenCalledWith({ type: "email", token_hash: "hash" });
    expect(response.headers.get("location")).toBe("https://mailhooks.cc/dashboard?template=x");
  });

  it("keeps a webhooks.cc link on webhooks.cc", async () => {
    twoSites();
    verifyOtp.mockResolvedValue({ error: null });
    const response = await GET(link("webhooks.cc", "https://webhooks.cc/cli/verify?code=A"));
    expect(response.headers.get("location")).toBe("https://webhooks.cc/cli/verify?code=A");
  });

  it("never forwards to a host that is not one of the sites", async () => {
    twoSites();
    verifyOtp.mockResolvedValue({ error: null });
    const response = await GET(link("webhooks.cc", "https://evil.example/dashboard"));
    expect(response.headers.get("location")).toBe("https://webhooks.cc/dashboard");
  });
});
