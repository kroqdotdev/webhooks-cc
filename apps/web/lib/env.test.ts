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
});
