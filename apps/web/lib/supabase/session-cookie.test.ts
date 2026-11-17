import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverSupabaseUrl, sessionCookieName } from "./session-cookie";

/** The storage key supabase-js itself picks for a client made with `url`. */
function defaultStorageKey(url: string): string {
  const client = createClient(url, "anon-key", {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return (client.auth as unknown as { storageKey: string }).storageKey;
}

describe("sessionCookieName", () => {
  it("matches the name supabase-js gives the public address", () => {
    for (const url of [
      "https://api1.webhooks.cc",
      "http://localhost:8000",
      "http://supabase.localhost:8000",
      "https://abcd1234.supabase.co",
    ]) {
      expect(sessionCookieName(url)).toBe(defaultStorageKey(url));
    }
  });

  it("is the public address's name, not the internal one's", () => {
    // The browser uses the public address, the server an internal one.
    expect(sessionCookieName("https://api1.webhooks.cc")).toBe("sb-api1-auth-token");
    expect(defaultStorageKey("http://gateway:8000")).toBe("sb-gateway-auth-token");
  });
});

describe("serverSupabaseUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers the internal address", () => {
    vi.stubEnv("SUPABASE_URL", "http://gateway:8000");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://api1.webhooks.cc");
    expect(serverSupabaseUrl()).toBe("http://gateway:8000");
  });

  it("falls back to the public address", () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://api1.webhooks.cc");
    expect(serverSupabaseUrl()).toBe("https://api1.webhooks.cc");
  });
});
