import { afterEach, describe, expect, it, vi } from "vitest";

// serverEnv() parses an explicit list of process.env reads, so a key added to
// the schema but not to that list silently takes its default. Load the real
// module, not a mock, so the list is what gets tested.
async function loadServerEnv() {
  vi.stubEnv("CAPTURE_SHARED_SECRET", "test-secret");
  vi.stubEnv("SUPABASE_URL", "http://localhost:8000");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  vi.stubEnv("RECEIVER_INTERNAL_URL", "http://localhost:3001");
  vi.stubEnv("NODE_ENV", "test");
  vi.resetModules();
  const { serverEnv } = await import("./env");
  return serverEnv();
}

describe("serverEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads QUOTA_EMAILS_ENABLED from the environment", async () => {
    vi.stubEnv("QUOTA_EMAILS_ENABLED", "true");
    expect((await loadServerEnv()).QUOTA_EMAILS_ENABLED).toBe(true);
  });

  it("defaults QUOTA_EMAILS_ENABLED to false", async () => {
    vi.stubEnv("QUOTA_EMAILS_ENABLED", "");
    expect((await loadServerEnv()).QUOTA_EMAILS_ENABLED).toBe(false);
  });

  it("takes the resolver forms Resolver.setServers() accepts", async () => {
    const list = "1.1.1.1, 9.9.9.9:53,[8.8.8.8]:53,2606:4700:4700::1111,[2001:4860:4860::8888]:53";
    vi.stubEnv("DOMAIN_DNS_SERVERS", list);
    expect((await loadServerEnv()).DOMAIN_DNS_SERVERS).toBe(list);
    vi.stubEnv("DOMAIN_DNS_SERVERS", "");
    expect((await loadServerEnv()).DOMAIN_DNS_SERVERS).toBeUndefined();
  });

  it.each(["dns.google", "1.1.1.1,", "1.1.1.1:99999", "2606:4700::1111:53x"])(
    "refuses DOMAIN_DNS_SERVERS=%s at startup",
    async (value) => {
      vi.stubEnv("DOMAIN_DNS_SERVERS", value);
      await expect(loadServerEnv()).rejects.toThrow(/DOMAIN_DNS_SERVERS/);
    }
  );

  it("takes a socks5 FILE_DROP_PROXY_URL with a host and a port", async () => {
    vi.stubEnv("FILE_DROP_PROXY_URL", "socks5://drop:secret@10.0.0.3:1080");
    expect((await loadServerEnv()).FILE_DROP_PROXY_URL).toBe("socks5://drop:secret@10.0.0.3:1080");
  });

  it.each(["http://10.0.0.3:1080", "socks5://10.0.0.3", "not a url"])(
    "refuses FILE_DROP_PROXY_URL=%s at startup",
    async (value) => {
      vi.stubEnv("FILE_DROP_PROXY_URL", value);
      await expect(loadServerEnv()).rejects.toThrow(/FILE_DROP_PROXY_URL/);
    }
  );
});
