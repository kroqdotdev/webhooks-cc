import { afterEach, describe, expect, test, vi } from "vitest";
import { timedFetch, withSupabaseCallTimeout } from "./call-timeout";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("withSupabaseCallTimeout", () => {
  test("cuts off a call that takes longer than the timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          })
      )
    );
    await expect(
      withSupabaseCallTimeout(20, () => timedFetch("https://db.test/rest/v1/x"))
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("leaves calls outside one alone, and keeps the caller's own signal", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await timedFetch("https://db.test/a");
    expect(fetchMock).toHaveBeenLastCalledWith("https://db.test/a", undefined);

    const own = new AbortController();
    await withSupabaseCallTimeout(1_000, () =>
      timedFetch("https://db.test/b", { signal: own.signal })
    );
    const signal = (fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit])[1].signal!;
    expect(signal.aborted).toBe(false);
    own.abort();
    expect(signal.aborted).toBe(true);
  });
});
