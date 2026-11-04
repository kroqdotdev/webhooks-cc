import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));
vi.mock("@/lib/observability", () => ({ reportError: vi.fn() }));

const { countApiRead, flushApiReads, takeApiReads } = await import("./analytics-reads");

const now = new Date("2026-11-04T12:00:00Z");

describe("countApiRead", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubEnv("ANALYTICS_SERVER", "true");
    takeApiReads();
    rpc.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("counts reads per account, day and client", () => {
    const read = { method: "GET", userId: "user-1", via: "api_key" as const, now };
    countApiRead({ ...read, userAgent: "webhooks-cc-python/0.5.0" });
    countApiRead({ ...read, userAgent: "webhooks-cc-python/0.5.0" });
    countApiRead({ ...read, userAgent: "whk-cli/1.8.0" });
    countApiRead({ ...read, method: "HEAD", userAgent: "whk-cli/1.8.0" });
    expect(takeApiReads()).toEqual([
      { user_id: "user-1", day: "2026-11-04", client: "python_sdk", reads: 2 },
      { user_id: "user-1", day: "2026-11-04", client: "cli", reads: 2 },
    ]);
    expect(takeApiReads()).toEqual([]);
  });

  it("names agent tokens the way audit events do", () => {
    const read = { method: "GET", userId: "user-1", via: "agent_token" as const, now };
    countApiRead({ ...read, userAgent: "webhooks-cc-mcp/1.17.0 webhooks-cc-sdk/1.21.0" });
    countApiRead({ ...read, userAgent: "curl/8.0" });
    expect(takeApiReads().map((row) => row.client)).toEqual(["mcp", "agent"]);
  });

  it("leaves out writes, accountless agents and disabled analytics", () => {
    countApiRead({ method: "POST", userId: "user-1", via: "api_key", userAgent: null, now });
    countApiRead({ method: "GET", userId: null, via: "agent_token", userAgent: null, now });
    vi.stubEnv("ANALYTICS_SERVER", "false");
    countApiRead({ method: "GET", userId: "user-1", via: "api_key", userAgent: null, now });
    expect(takeApiReads()).toEqual([]);
  });
});

describe("flushApiReads", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubEnv("ANALYTICS_SERVER", "true");
    takeApiReads();
    rpc.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("adds the counts in one call and starts again from zero", async () => {
    rpc.mockResolvedValue({ error: null });
    countApiRead({ method: "GET", userId: "user-1", via: "api_key", userAgent: "node", now });
    await flushApiReads();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("analytics_add_api_reads", {
      p_rows: [{ user_id: "user-1", day: "2026-11-04", client: "node", reads: 1 }],
    });
    await flushApiReads();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("holds back new keys while a flush is out, and puts every taken count back", async () => {
    let fail!: (value: { error: { message: string } }) => void;
    rpc.mockReturnValueOnce(new Promise((resolve) => (fail = resolve)));
    const read = { method: "GET", via: "api_key" as const, userAgent: "node", now };
    for (let i = 0; i < 20_000; i++) countApiRead({ ...read, userId: `user-${i}` });
    const flushing = flushApiReads();
    // The counter is empty, but its keys are still spoken for.
    countApiRead({ ...read, userId: "late" });
    fail({ error: { message: "down" } });
    await flushing;
    const rows = takeApiReads();
    expect(rows).toHaveLength(20_000);
    expect(rows.some((row) => row.user_id === "late")).toBe(false);
  });

  it("keeps the counts for the next flush when the write fails", async () => {
    rpc.mockResolvedValueOnce({ error: { message: "down" } });
    countApiRead({ method: "GET", userId: "user-1", via: "api_key", userAgent: "node", now });
    await flushApiReads();
    countApiRead({ method: "GET", userId: "user-1", via: "api_key", userAgent: "node", now });
    expect(takeApiReads()).toEqual([
      { user_id: "user-1", day: "2026-11-04", client: "node", reads: 2 },
    ]);
  });
});
