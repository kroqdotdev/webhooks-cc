import { afterEach, describe, expect, it, vi } from "vitest";
import { pingHeartbeat, startHeartbeat } from "./heartbeat";

describe("pingHeartbeat", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends nothing without a URL", async () => {
    const fetcher = vi.fn();
    expect(await pingHeartbeat(undefined, "test", fetcher)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("posts to the URL and reports success", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("ok"));
    expect(await pingHeartbeat("https://statoss.test/api/heartbeat/t", "ok-label", fetcher)).toBe(
      true
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://statoss.test/api/heartbeat/t",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("never throws, and warns once in a while", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const refusing = vi.fn().mockResolvedValue(new Response("no", { status: 404 }));
    expect(await pingHeartbeat("https://statoss.test/h", "flaky", failing)).toBe(false);
    expect(await pingHeartbeat("https://statoss.test/h", "flaky", refusing)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("flaky heartbeat not sent");
  });
});

describe("startHeartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("pings only while the job is alive", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetcher);
    let alive = true;
    startHeartbeat({
      url: "https://statoss.test/h",
      label: "job",
      alive: () => alive,
      everyMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    alive = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a URL", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    startHeartbeat({ url: undefined, label: "off", alive: () => true, everyMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
