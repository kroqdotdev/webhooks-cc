import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultDashboardEndpoint,
  fetchDashboardSearch,
  fetchDashboardSearchCount,
  isAbortError,
  readSearchProgress,
  SearchBusyError,
} from "./dashboard-api";

describe("defaultDashboardEndpoint", () => {
  it("opens the first favourite, else the first endpoint", () => {
    const a = { slug: "a" };
    const b = { slug: "b", favorite: true };
    const c = { slug: "c", favorite: true };
    expect(defaultDashboardEndpoint([a, b, c])).toBe(b);
    expect(defaultDashboardEndpoint([a, { slug: "d", favorite: false }])).toBe(a);
    expect(defaultDashboardEndpoint([])).toBeUndefined();
  });
});

describe("readSearchProgress", () => {
  it("reads where an incomplete search stopped", () => {
    expect(
      readSearchProgress(
        new Headers({
          "X-Search-Complete": "false",
          "X-Search-Searched-Until": "1763000000000",
          "X-Search-Cursor": "abc+def",
        })
      )
    ).toEqual({ complete: false, searchedUntil: 1763000000000, cursor: "abc+def" });
  });

  it("reads a complete search over an open range", () => {
    expect(readSearchProgress(new Headers({ "X-Search-Complete": "true" }))).toEqual({
      complete: true,
      searchedUntil: null,
      cursor: null,
    });
  });

  it("takes an answer without the headers as complete", () => {
    expect(readSearchProgress(new Headers())).toEqual({
      complete: true,
      searchedUntil: null,
      cursor: null,
    });
  });

  it("ignores a time that is not a number", () => {
    expect(
      readSearchProgress(
        new Headers({ "X-Search-Complete": "false", "X-Search-Searched-Until": "soon" })
      ).searchedUntil
    ).toBeNull();
  });
});

describe("dashboard search requests", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("window", { location: { origin: "https://app.test" } });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("returns the page with its progress and passes the signal on", async () => {
    fetchMock.mockResolvedValue(
      Response.json([{ id: "r1" }], {
        headers: {
          "X-Search-Complete": "false",
          "X-Search-Searched-Until": "1700",
          "X-Search-Cursor": "c1",
        },
      })
    );
    const controller = new AbortController();
    const page = await fetchDashboardSearch(
      "token",
      { slug: "demo", q: "a b", cursor: "x+y" },
      controller.signal
    );

    expect(page).toEqual({
      requests: [{ id: "r1" }],
      complete: false,
      searchedUntil: 1700,
      cursor: "c1",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://app.test/api/search/requests?slug=demo&q=a+b&cursor=x%2By&paged=true"
    );
    expect(init?.signal).toBe(controller.signal);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token");
  });

  const busy = (retryAfter: string) =>
    Response.json(
      { error: "search_busy" },
      { status: 429, headers: { "Retry-After": retryAfter } }
    );

  it("tries a busy search once more after the wait the server names", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(busy("2"))
        .mockResolvedValueOnce(Response.json([{ id: "r1" }]));
      const pending = fetchDashboardSearch("token", { slug: "demo" });
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).requests).toEqual([{ id: "r1" }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits 3 seconds at most, and throws SearchBusyError when still busy", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(async () => busy("30"));
      const pending = fetchDashboardSearch("token", { slug: "demo" }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(3000);
      const err = await pending;
      expect(err).toBeInstanceOf(SearchBusyError);
      expect((err as SearchBusyError).retryAfterSeconds).toBe(30);
      // One retry, not a loop.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up the wait when the search is aborted", async () => {
    fetchMock.mockImplementation(async () => busy("3"));
    const controller = new AbortController();
    const pending = fetchDashboardSearch("token", { slug: "demo" }, controller.signal).catch(
      (e: unknown) => e
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(isAbortError(await pending)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends paged=true with a count too", async () => {
    fetchMock.mockResolvedValue(Response.json({ count: 1, exact: true }));
    await fetchDashboardSearchCount("token", { slug: "demo" });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://app.test/api/search/requests/count?slug=demo&paged=true"
    );
  });

  it("keeps other failures as plain errors", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "invalid_cursor" }, { status: 400 }));
    const err = await fetchDashboardSearch("token", { slug: "demo" }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SearchBusyError);
    expect((err as Error).message).toBe("invalid_cursor");

    fetchMock.mockResolvedValue(Response.json({ error: "Too many requests" }, { status: 429 }));
    const limited = await fetchDashboardSearch("token", { slug: "demo" }).catch((e: unknown) => e);
    expect(limited).not.toBeInstanceOf(SearchBusyError);
  });

  it("lets an aborted fetch reject as an AbortError", async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError"))
          );
        })
    );
    const controller = new AbortController();
    const pending = fetchDashboardSearch("token", { slug: "demo", q: "x" }, controller.signal);
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(isAbortError(new Error("boom"))).toBe(false);
  });

  it("reads a count and whether it is exact", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ count: 12, exact: false, searchedUntil: 5, cursor: "c" })
    );
    const controller = new AbortController();
    expect(await fetchDashboardSearchCount("token", { slug: "demo" }, controller.signal)).toEqual({
      count: 12,
      exact: false,
    });
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);

    // An answer from before the field existed counted everything.
    fetchMock.mockResolvedValue(Response.json({ count: 3 }));
    expect(await fetchDashboardSearchCount("token", { slug: "demo" })).toEqual({
      count: 3,
      exact: true,
    });
  });
});
