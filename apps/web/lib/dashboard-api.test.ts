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
    expect(url).toBe("https://app.test/api/search/requests?slug=demo&q=a+b&cursor=x%2By");
    expect(init?.signal).toBe(controller.signal);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token");
  });

  it("throws SearchBusyError with the wait on a busy answer", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "search_busy" }, { status: 429, headers: { "Retry-After": "2" } })
    );
    const err = await fetchDashboardSearch("token", { slug: "demo" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchBusyError);
    expect((err as SearchBusyError).retryAfterSeconds).toBe(2);
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
