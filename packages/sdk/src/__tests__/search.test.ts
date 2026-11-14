import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebhooksCC } from "../client";
import { RateLimitError, TimeoutError, WebhooksCCError } from "../errors";

const BASE_URL = "https://test.webhooks.cc";

interface Answer {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Moves the clock on before answering, as a slow page would. */
  takesMs?: number;
}

function answer({ status = 200, body, headers, takesMs }: Answer) {
  if (takesMs) vi.setSystemTime(Date.now() + takesMs);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json", ...headers }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/** A fetch that gives the answers in turn, and repeats the last one. */
function mockPages(...answers: Answer[]) {
  let call = 0;
  return vi.fn().mockImplementation(async () => {
    const next = answers[Math.min(call, answers.length - 1)];
    call++;
    return answer(next);
  });
}

function hit(id: string) {
  return {
    id,
    slug: "abc",
    method: "POST",
    path: "/hooks",
    headers: {},
    body: "needle",
    queryParams: {},
    ip: "127.0.0.1",
    size: 6,
    receivedAt: 1_700_000_000_000,
  };
}

function more(cursor: string, searchedUntil = 1_700_000_000_000) {
  return {
    "X-Search-Complete": "false",
    "X-Search-Searched-Until": String(searchedUntil),
    "X-Search-Cursor": cursor,
  };
}

const done = { "X-Search-Complete": "true" };

function urlOf(fetchMock: ReturnType<typeof vi.fn>, call: number): URL {
  return new URL(fetchMock.mock.calls[call][0] as string);
}

function createClient(retry?: { maxAttempts?: number; backoffMs?: number }) {
  return new WebhooksCC({ apiKey: "whcc_testkey123", baseUrl: BASE_URL, retry });
}

describe("search with a cursor", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-14T12:00:00.000Z"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("requests.searchPage", () => {
    it("asks for one paged page and reads how far it got from the headers", async () => {
      const fetchMock = mockPages({ body: [hit("r1")], headers: more("c1", 1_699_000_000_000) });
      globalThis.fetch = fetchMock;

      const page = await createClient().requests.searchPage({
        slug: "abc",
        q: "needle",
        limit: 10,
        offset: 3,
        order: "desc",
      });

      expect(page).toEqual({
        requests: [hit("r1")],
        complete: false,
        searchedUntil: 1_699_000_000_000,
        cursor: "c1",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      const url = urlOf(fetchMock, 0);
      expect(url.pathname).toBe("/api/search/requests");
      expect(url.searchParams.get("paged")).toBe("true");
      expect(url.searchParams.get("limit")).toBe("10");
      expect(url.searchParams.get("offset")).toBe("3");
      expect(url.searchParams.get("cursor")).toBeNull();
    });

    it("sends the cursor without the offset", async () => {
      const fetchMock = mockPages({ body: [], headers: done });
      globalThis.fetch = fetchMock;

      const page = await createClient().requests.searchPage(
        { q: "needle", limit: 10, offset: 3 },
        { cursor: "c1" }
      );

      expect(page).toEqual({ requests: [], complete: true, searchedUntil: null, cursor: null });
      const url = urlOf(fetchMock, 0);
      expect(url.searchParams.get("cursor")).toBe("c1");
      expect(url.searchParams.get("offset")).toBeNull();
      expect(url.searchParams.get("limit")).toBe("10");
      expect(url.searchParams.get("paged")).toBe("true");
    });

    it("reads a complete page with a searched-until time", async () => {
      globalThis.fetch = mockPages({
        body: [],
        headers: { "X-Search-Complete": "true", "X-Search-Searched-Until": "1699000000000" },
      });
      const page = await createClient().requests.searchPage({ q: "needle" });
      expect(page.complete).toBe(true);
      expect(page.searchedUntil).toBe(1_699_000_000_000);
      expect(page.cursor).toBeNull();
    });

    it("takes a server that sends no search headers as complete", async () => {
      globalThis.fetch = mockPages({ body: [hit("r1")] });
      const page = await createClient().requests.searchPage({ q: "needle" });
      expect(page).toEqual({
        requests: [hit("r1")],
        complete: true,
        searchedUntil: null,
        cursor: null,
      });
    });

    it("surfaces invalid_cursor as an error with that code", async () => {
      globalThis.fetch = mockPages({ status: 400, body: { error: "invalid_cursor" } });
      const error = await createClient()
        .requests.searchPage({ q: "needle" }, { cursor: "made-up" })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WebhooksCCError);
      expect((error as WebhooksCCError).statusCode).toBe(400);
      expect((error as WebhooksCCError).code).toBe("invalid_cursor");
    });

    it("leaves a busy answer to the caller, with its code and wait", async () => {
      const fetchMock = mockPages({
        status: 429,
        body: {
          error: "search_busy",
          message: "Too many searches are running; try again shortly.",
        },
        headers: { "Retry-After": "2" },
      });
      globalThis.fetch = fetchMock;
      const error = await createClient()
        .requests.searchPage({ q: "needle" })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).code).toBe("search_busy");
      expect((error as RateLimitError).retryAfter).toBe(2);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("gives errors without a code none", async () => {
      globalThis.fetch = mockPages({ status: 401, body: { error: "Invalid token" } });
      const error = await createClient()
        .requests.searchPage()
        .catch((e: unknown) => e);
      expect((error as WebhooksCCError).code).toBeUndefined();
    });
  });

  describe("requests.search", () => {
    it("follows the cursor until it has limit matches", async () => {
      const fetchMock = mockPages(
        { body: [hit("r1"), hit("r2")], headers: more("c1") },
        { body: [], headers: more("c2") },
        { body: [hit("r3"), hit("r4")], headers: more("c3") },
        { body: [hit("never")], headers: done }
      );
      globalThis.fetch = fetchMock;

      const results = await createClient().requests.search({ q: "needle", limit: 3, offset: 7 });

      expect(results.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      const first = urlOf(fetchMock, 0);
      expect(first.searchParams.get("paged")).toBe("true");
      expect(first.searchParams.get("offset")).toBe("7");
      expect(first.searchParams.get("limit")).toBe("3");
      expect(first.searchParams.get("cursor")).toBeNull();

      const second = urlOf(fetchMock, 1);
      expect(second.searchParams.get("cursor")).toBe("c1");
      expect(second.searchParams.get("offset")).toBeNull();
      expect(second.searchParams.get("limit")).toBe("1");
      expect(second.searchParams.get("paged")).toBe("true");
      expect(second.searchParams.get("q")).toBe("needle");

      const third = urlOf(fetchMock, 2);
      expect(third.searchParams.get("cursor")).toBe("c2");
      expect(third.searchParams.get("offset")).toBeNull();
    });

    it("stops when the search is complete", async () => {
      const fetchMock = mockPages(
        { body: [hit("r1")], headers: more("c1") },
        { body: [hit("r2")], headers: done }
      );
      globalThis.fetch = fetchMock;

      const results = await createClient().requests.search({ q: "needle" });

      expect(results.map((r) => r.id)).toEqual(["r1", "r2"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Without a limit the server's default (50) applies to the first page.
      expect(urlOf(fetchMock, 0).searchParams.get("limit")).toBeNull();
      expect(urlOf(fetchMock, 1).searchParams.get("limit")).toBe("49");
    });

    it("stops after 25 seconds and returns what it found", async () => {
      const fetchMock = mockPages(
        { body: [hit("r1")], headers: more("c1"), takesMs: 10_000 },
        { body: [], headers: more("c2"), takesMs: 10_000 },
        { body: [hit("r2")], headers: more("c3"), takesMs: 10_000 },
        { body: [hit("never")], headers: more("c4") }
      );
      globalThis.fetch = fetchMock;

      const results = await createClient().requests.search({ q: "needle" });

      expect(results.map((r) => r.id)).toEqual(["r1", "r2"]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("keeps one time range for every page of a search", async () => {
      const fetchMock = mockPages(
        { body: [], headers: more("c1"), takesMs: 5_000 },
        { body: [], headers: done }
      );
      globalThis.fetch = fetchMock;
      const started = Date.now();

      await createClient().requests.search({ q: "needle", from: "1h", to: "5m" });

      for (const call of [0, 1]) {
        const params = urlOf(fetchMock, call).searchParams;
        expect(params.get("from")).toBe(String(started - 3_600_000));
        expect(params.get("to")).toBe(String(started - 300_000));
      }
    });

    it("waits out a busy answer and reads on", async () => {
      const fetchMock = mockPages(
        { body: [hit("r1")], headers: more("c1") },
        { status: 429, body: { error: "search_busy" }, headers: { "Retry-After": "2" } },
        { body: [hit("r2")], headers: done }
      );
      globalThis.fetch = fetchMock;

      const pending = createClient().requests.search({ q: "needle" });
      await vi.advanceTimersByTimeAsync(2_000);
      const results = await pending;

      expect(results.map((r) => r.id)).toEqual(["r1", "r2"]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(urlOf(fetchMock, 2).searchParams.get("cursor")).toBe("c1");
    });

    it("returns what it found when the server stays busy to the deadline", async () => {
      const fetchMock = mockPages(
        { body: [hit("r1")], headers: more("c1") },
        { status: 429, body: { error: "search_busy" }, headers: { "Retry-After": "2" } }
      );
      globalThis.fetch = fetchMock;

      const pending = createClient().requests.search({ q: "needle" });
      await vi.advanceTimersByTimeAsync(30_000);

      expect((await pending).map((r) => r.id)).toEqual(["r1"]);
      // Bounded: one try every 2 s while the next still fits before 25 s.
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(14);
    });

    it("fails when the first page stays busy", async () => {
      globalThis.fetch = mockPages({
        status: 429,
        body: { error: "search_busy" },
        headers: { "Retry-After": "2" },
      });

      const pending = createClient()
        .requests.search({ q: "needle" })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(await pending).toBeInstanceOf(RateLimitError);
    });

    it("does not wait on an ordinary rate limit", async () => {
      const fetchMock = mockPages({
        status: 429,
        body: { error: "Too many requests" },
        headers: { "Retry-After": "30" },
      });
      globalThis.fetch = fetchMock;

      await expect(createClient().requests.search({ q: "needle" })).rejects.toBeInstanceOf(
        RateLimitError
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("surfaces invalid_cursor from a later page", async () => {
      globalThis.fetch = mockPages(
        { body: [hit("r1")], headers: more("c1") },
        { status: 400, body: { error: "invalid_cursor" } }
      );
      await expect(createClient().requests.search({ q: "needle" })).rejects.toMatchObject({
        statusCode: 400,
        code: "invalid_cursor",
      });
    });
  });

  describe("a page begun near the deadline", () => {
    /** Answers the first call after `firstTakesMs`; later calls hang until aborted. */
    function mockThenHang(first: Answer) {
      let call = 0;
      return vi.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) => {
        if (call++ === 0) return Promise.resolve(answer(first));
        return new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      });
    }

    async function settledAfter(pending: Promise<unknown>, ms: number): Promise<unknown> {
      let outcome: unknown = "pending";
      void pending.then(
        (value) => (outcome = value),
        (error: unknown) => (outcome = error)
      );
      await vi.advanceTimersByTimeAsync(ms);
      return outcome;
    }

    it("search() gives it the time left plus 5 seconds, then returns what it found", async () => {
      // The first page ends 1 s before the deadline, so the second gets 6 s.
      const fetchMock = mockThenHang({ body: [hit("r1")], headers: more("c1"), takesMs: 24_000 });
      globalThis.fetch = fetchMock;

      const pending = createClient().requests.search({ q: "needle" });
      expect(await settledAfter(pending, 5_900)).toBe("pending");
      const outcome = await settledAfter(pending, 200);

      expect((outcome as Array<{ id: string }>).map((r) => r.id)).toEqual(["r1"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("count() gives it the time left plus 5 seconds, then returns the sum so far", async () => {
      globalThis.fetch = mockThenHang({
        body: { count: 2, exact: false, searchedUntil: 3, cursor: "c1" },
        takesMs: 24_000,
      });

      const pending = createClient().requests.count({ q: "needle" });
      expect(await settledAfter(pending, 5_900)).toBe("pending");
      expect(await settledAfter(pending, 200)).toBe(2);
    });

    it("fails when the first page times out", async () => {
      // No page came back: there is nothing to return, even with a short limit.
      globalThis.fetch = vi
        .fn()
        .mockImplementation((_url: string, init: { signal: AbortSignal }) => {
          return new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          });
        });
      const client = new WebhooksCC({
        apiKey: "whcc_testkey123",
        baseUrl: BASE_URL,
        timeout: 60_000,
      });

      const search = client.requests.search({ q: "needle" });
      const count = client.requests.count({ q: "needle" }).catch((e: unknown) => e);
      expect(await settledAfter(search, 29_900)).toBe("pending");
      expect(await settledAfter(search, 200)).toBeInstanceOf(TimeoutError);
      expect(await count).toBeInstanceOf(TimeoutError);
    });

    it("fails on a later page that used up the client's own timeout", async () => {
      globalThis.fetch = mockThenHang({ body: [hit("r1")], headers: more("c1") });

      const client = new WebhooksCC({
        apiKey: "whcc_testkey123",
        baseUrl: BASE_URL,
        timeout: 3_000,
      });
      const pending = client.requests.search({ q: "needle" });
      expect(await settledAfter(pending, 2_900)).toBe("pending");
      expect(await settledAfter(pending, 200)).toBeInstanceOf(TimeoutError);
    });

    it("searchPage() and countPage() keep the client's timeout", async () => {
      const fetchMock = mockThenHang({ body: [hit("r1")], headers: more("c1"), takesMs: 24_000 });
      globalThis.fetch = fetchMock;
      const client = createClient();
      await client.requests.searchPage({ q: "needle" });

      const page = client.requests.searchPage({ q: "needle" }, { cursor: "c1" });
      const count = client.requests.countPage({ q: "needle" });
      expect(await settledAfter(page, 29_900)).toBe("pending");
      expect(await settledAfter(count, 0)).toBe("pending");
      expect(await settledAfter(page, 200)).toBeInstanceOf(TimeoutError);
      expect(await settledAfter(count, 0)).toBeInstanceOf(TimeoutError);
    });
  });

  describe("requests.countPage", () => {
    it("returns one page of a count and sends the cursor", async () => {
      const fetchMock = mockPages({
        body: { count: 4, exact: false, searchedUntil: 1_699_000_000_000, cursor: "c2" },
      });
      globalThis.fetch = fetchMock;

      const page = await createClient().requests.countPage(
        { slug: "abc", q: "needle", limit: 5, offset: 2, order: "asc" },
        { cursor: "c1" }
      );

      expect(page).toEqual({
        count: 4,
        exact: false,
        searchedUntil: 1_699_000_000_000,
        cursor: "c2",
      });
      const url = urlOf(fetchMock, 0);
      expect(url.pathname).toBe("/api/search/requests/count");
      expect(url.searchParams.get("paged")).toBe("true");
      expect(url.searchParams.get("cursor")).toBe("c1");
      expect(url.searchParams.get("limit")).toBeNull();
      expect(url.searchParams.get("offset")).toBeNull();
      expect(url.searchParams.get("order")).toBeNull();
    });

    it("takes an answer with only a count as exact", async () => {
      globalThis.fetch = mockPages({ body: { count: 7 } });
      expect(await createClient().requests.countPage({ slug: "abc" })).toEqual({
        count: 7,
        exact: true,
        searchedUntil: null,
        cursor: null,
      });
    });
  });

  describe("requests.count", () => {
    it("adds the counts up until the count is exact", async () => {
      const fetchMock = mockPages(
        { body: { count: 4, exact: false, searchedUntil: 3, cursor: "c1" } },
        { body: { count: 0, exact: false, searchedUntil: 2, cursor: "c2" } },
        { body: { count: 5, exact: true, searchedUntil: null, cursor: null } },
        { body: { count: 100, exact: true, searchedUntil: null, cursor: null } }
      );
      globalThis.fetch = fetchMock;

      expect(await createClient().requests.count({ q: "needle" })).toBe(9);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(urlOf(fetchMock, 0).searchParams.get("cursor")).toBeNull();
      expect(urlOf(fetchMock, 0).searchParams.get("paged")).toBe("true");
      expect(urlOf(fetchMock, 1).searchParams.get("cursor")).toBe("c1");
      expect(urlOf(fetchMock, 2).searchParams.get("cursor")).toBe("c2");
    });

    it("stops after 25 seconds with the count so far", async () => {
      const fetchMock = mockPages({
        body: { count: 2, exact: false, searchedUntil: 3, cursor: "c" },
        takesMs: 10_000,
      });
      globalThis.fetch = fetchMock;

      expect(await createClient().requests.count({ q: "needle" })).toBe(6);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  it("leaves other calls' retries as they were", async () => {
    const fetchMock = mockPages(
      { status: 429, body: { error: "Too many requests" }, headers: { "Retry-After": "1" } },
      { body: [hit("r1")], headers: done }
    );
    globalThis.fetch = fetchMock;

    const pending = createClient({ maxAttempts: 2 }).requests.searchPage({ q: "needle" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await pending).requests).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
