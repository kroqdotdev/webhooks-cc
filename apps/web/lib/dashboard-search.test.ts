import { describe, expect, test } from "vitest";

import {
  arrivalsFrom,
  buildSearchParams,
  canSearchOlder,
  collectExportRows,
  createCoalescedRunner,
  exportNotice,
  progressOf,
  reconcileTopRefresh,
  searchWording,
  createLatestOnly,
  mergeSearchResults,
  SEARCH_NOT_STARTED,
} from "./dashboard-search";

const row = (id: string, receivedAt: number, path = "/") => ({ id, receivedAt, path });

describe("mergeSearchResults", () => {
  test("appends an older page below the matches shown", () => {
    const shown = [row("c", 300), row("b", 200)];
    expect(mergeSearchResults(shown, [row("a", 100)]).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  test("puts newer arrivals at the top", () => {
    const shown = [row("b", 200), row("a", 100)];
    expect(mergeSearchResults(shown, [row("d", 400), row("c", 300)]).map((r) => r.id)).toEqual([
      "d",
      "c",
      "b",
      "a",
    ]);
  });

  test("keeps one row per id, the page's copy", () => {
    const shown = [row("b", 200, "/old"), row("a", 100)];
    const merged = mergeSearchResults(shown, [row("b", 200, "/new"), row("c", 300)]);
    expect(merged.map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(merged[1].path).toBe("/new");
  });

  test("returns the same list for an empty page", () => {
    const shown = [row("a", 100)];
    expect(mergeSearchResults(shown, [])).toBe(shown);
  });
});

describe("canSearchOlder", () => {
  test("only an incomplete search with a cursor can continue", () => {
    expect(canSearchOlder(SEARCH_NOT_STARTED)).toBe(false);
    expect(canSearchOlder({ complete: true, searchedUntil: 5, cursor: null })).toBe(false);
    expect(canSearchOlder({ complete: false, searchedUntil: 5, cursor: null })).toBe(false);
    expect(canSearchOlder({ complete: false, searchedUntil: 5, cursor: "next" })).toBe(true);
  });
});

describe("buildSearchParams", () => {
  test("sends the term newest first, and only the filters that are picked", () => {
    expect(
      buildSearchParams({
        slug: "demo",
        query: "needle",
        methodFilter: "ALL",
        kindFilter: "all",
        limit: 50,
      })
    ).toEqual({ slug: "demo", q: "needle", limit: "50", order: "desc" });
    // Oldest first searches, and continues, forward in time.
    expect(
      buildSearchParams({
        slug: "demo",
        query: "needle",
        methodFilter: "ALL",
        kindFilter: "all",
        limit: 50,
        order: "asc",
      }).order
    ).toBe("asc");
    expect(
      buildSearchParams({
        slug: "demo",
        query: "needle",
        methodFilter: "POST",
        kindFilter: "http",
        limit: 50,
      })
    ).toEqual({
      slug: "demo",
      q: "needle",
      limit: "50",
      order: "desc",
      method: "POST",
      kind: "http",
    });
  });
});

describe("arrivalsFrom", () => {
  test("starts at the newest match shown", () => {
    expect(arrivalsFrom([row("a", 100), row("c", 300.7), row("b", 200)], 50)).toBe(300);
  });

  test("starts at the anchor when nothing matched yet", () => {
    expect(arrivalsFrom([], 1234)).toBe(1234);
  });

  test("never goes back before the anchor", () => {
    // Older matches say nothing about the range between them and the anchor,
    // which the search already read.
    expect(arrivalsFrom([row("a", 100)], 900)).toBe(900);
  });
});

describe("createLatestOnly", () => {
  test("starting the next run aborts the one before", () => {
    const runs = createLatestOnly();
    const first = runs.start();
    expect(first.aborted).toBe(false);
    const second = runs.start();
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
  });

  test("abort ends the current run and leaves the next one alone", () => {
    const runs = createLatestOnly();
    const first = runs.start();
    runs.abort();
    expect(first.aborted).toBe(true);
    runs.abort();
    expect(runs.start().aborted).toBe(false);
  });
});

describe("createCoalescedRunner", () => {
  /** A task that records its name and finishes when released. */
  function gated(log: string[], name: string) {
    let release = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      release,
      task: async () => {
        log.push(`start ${name}`);
        await done;
        log.push(`end ${name}`);
      },
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("a request during a run waits for it, and several become one", async () => {
    const log: string[] = [];
    const runner = createCoalescedRunner();
    const first = gated(log, "first");
    const second = gated(log, "second");
    const third = gated(log, "third");

    void runner.request(first.task);
    void runner.request(second.task);
    void runner.request(third.task);
    // The first run is neither joined nor cut short.
    expect(log).toEqual(["start first"]);

    first.release();
    await settle();
    expect(log).toEqual(["start first", "end first", "start third"]);
    third.release();
    await settle();
    expect(log).toEqual(["start first", "end first", "start third", "end third"]);

    // Idle again: the next request runs at once.
    void runner.request(second.task);
    expect(log.at(-1)).toBe("start second");
  });

  test("clear forgets a request that has not started", async () => {
    const log: string[] = [];
    const runner = createCoalescedRunner();
    const first = gated(log, "first");
    const second = gated(log, "second");

    void runner.request(first.task);
    void runner.request(second.task);
    runner.clear();
    first.release();
    await settle();
    expect(log).toEqual(["start first", "end first"]);
  });
});

describe("progressOf", () => {
  test("keeps the progress and leaves the requests behind", () => {
    const page = { requests: [row("a", 1)], complete: false, searchedUntil: 9, cursor: "c" };
    expect(progressOf(page)).toEqual({ complete: false, searchedUntil: 9, cursor: "c" });
  });
});

describe("searchWording", () => {
  test("continuing means older newest first and newer oldest first", () => {
    expect(searchWording("desc").action).toBe("Search older");
    expect(searchWording("desc").reached).toBe("Searched back to");
    expect(searchWording("asc").action).toBe("Search newer");
    expect(searchWording("asc").reached).toBe("Searched up to");
    expect(searchWording("asc").unsearched("emails")).toBe("Newer emails not searched yet");
  });
});

describe("reconcileTopRefresh", () => {
  // "Search older" read back to 1000 and can go on from there.
  const older = { complete: false, searchedUntil: 1000, cursor: "older" };

  test("keeps the older progress when the fresh page read down to what was covered", () => {
    const fresh = { complete: false, searchedUntil: 4000, cursor: "fresh" };
    expect(reconcileTopRefresh(older, fresh, 5000)).toBe(older);
    expect(reconcileTopRefresh(older, { ...fresh, searchedUntil: 5000 }, 5000)).toBe(older);
  });

  test("keeps a finished search finished when the fresh page joins it", () => {
    const done = { complete: true, searchedUntil: null, cursor: null };
    const fresh = { complete: false, searchedUntil: 4000, cursor: "fresh" };
    expect(reconcileTopRefresh(done, fresh, 5000)).toBe(done);
  });

  test("goes on from the fresh page when it stopped above what was covered", () => {
    const fresh = { complete: false, searchedUntil: 7000, cursor: "fresh" };
    expect(reconcileTopRefresh(older, fresh, 5000)).toEqual(fresh);
    // Not knowing how far it read is not knowing that it joined.
    expect(reconcileTopRefresh(older, { ...fresh, searchedUntil: null }, 5000).cursor).toBe(
      "fresh"
    );
  });

  test("a fresh page that read everything finishes the search", () => {
    const fresh = { complete: true, searchedUntil: null, cursor: null };
    expect(reconcileTopRefresh(older, fresh, 5000)).toEqual(fresh);
  });
});

describe("collectExportRows", () => {
  const page = (
    ids: string[],
    progress: { complete: boolean; searchedUntil?: number | null; cursor?: string | null }
  ) => ({
    requests: ids.map((id) => ({ id })),
    complete: progress.complete,
    searchedUntil: progress.searchedUntil ?? null,
    cursor: progress.cursor ?? null,
  });
  /** Answers page by page and records the cursors asked for. */
  function pages(answers: (ReturnType<typeof page> | Error)[]) {
    const cursors: (string | null)[] = [];
    return {
      cursors,
      fetchPage: async (cursor: string | null) => {
        cursors.push(cursor);
        const answer = answers[cursors.length - 1];
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
  }
  const limits = { maxRows: 5, maxPages: 5 };

  test("follows the cursor until the range is read", async () => {
    const source = pages([
      page(["a", "b"], { complete: false, searchedUntil: 900, cursor: "c1" }),
      page(["c"], { complete: true }),
    ]);
    expect(await collectExportRows(source.fetchPage, limits)).toEqual({
      rows: [{ id: "a" }, { id: "b" }, { id: "c" }],
      complete: true,
      truncated: false,
      searchedUntil: null,
    });
    expect(source.cursors).toEqual([null, "c1"]);
  });

  test("an empty page that is not complete is not a failure", async () => {
    const source = pages([
      page([], { complete: false, searchedUntil: 900, cursor: "c1" }),
      page([], { complete: false, searchedUntil: 800, cursor: "c2" }),
      page(["a"], { complete: true }),
    ]);
    const result = await collectExportRows(source.fetchPage, limits);
    expect(result.rows).toEqual([{ id: "a" }]);
    expect(result.complete).toBe(true);
  });

  test("stops at the row limit and says it was cut", async () => {
    const source = pages([
      page(["a", "b", "c"], { complete: false, searchedUntil: 900, cursor: "c1" }),
      page(["c", "d", "e", "f"], { complete: false, searchedUntil: 800, cursor: "c2" }),
      page(["g"], { complete: true }),
    ]);
    const result = await collectExportRows(source.fetchPage, limits);
    // One row per id, and no more than asked for.
    expect(result.rows.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(result.truncated).toBe(true);
    expect(source.cursors).toEqual([null, "c1"]);
  });

  test("stops after the page limit with how far it searched", async () => {
    const source = pages(
      Array.from({ length: 9 }, (_, i) =>
        page([], { complete: false, searchedUntil: 900 - i, cursor: `c${i}` })
      )
    );
    const result = await collectExportRows(source.fetchPage, limits);
    expect(source.cursors).toHaveLength(5);
    expect(result).toEqual({ rows: [], complete: false, truncated: false, searchedUntil: 896 });
  });

  test("keeps what it has when a later page fails, and throws when the first does", async () => {
    const later = pages([
      page(["a"], { complete: false, searchedUntil: 900, cursor: "c1" }),
      new Error("boom"),
    ]);
    expect(await collectExportRows(later.fetchPage, limits)).toEqual({
      rows: [{ id: "a" }],
      complete: false,
      truncated: false,
      searchedUntil: 900,
    });
    await expect(collectExportRows(pages([new Error("boom")]).fetchPage, limits)).rejects.toThrow(
      "boom"
    );
  });
});

describe("exportNotice", () => {
  const at = (timestamp: number) => `T${timestamp}`;
  const result = (count: number, rest: Partial<Parameters<typeof exportNotice>[0]> = {}) => ({
    rows: { length: count },
    complete: true,
    truncated: false,
    searchedUntil: null,
    ...rest,
  });

  test("says nothing about an export that holds everything", () => {
    expect(exportNotice(result(12), at)).toBeNull();
  });

  test("says how far an unfinished export searched", () => {
    expect(exportNotice(result(12, { complete: false, searchedUntil: 900 }), at)).toBe(
      "Exported 12 requests: what was found searching back to T900. Older requests were not searched."
    );
    expect(exportNotice(result(0, { complete: false, searchedUntil: 900 }), at)).toBe(
      "Nothing to export yet: nothing matched in what was searched back to T900. Older requests were not searched."
    );
  });

  test("tells an export cut at the row limit and an empty one apart", () => {
    expect(exportNotice(result(200, { complete: false, truncated: true }), at)).toBe(
      "Exported first 200 requests. Use search filters to narrow the export."
    );
    expect(exportNotice(result(0), at)).toBe("Nothing to export: no requests match.");
  });
});
