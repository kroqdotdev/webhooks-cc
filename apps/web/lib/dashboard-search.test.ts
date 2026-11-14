import { describe, expect, test } from "vitest";

import {
  arrivalsFrom,
  buildSearchParams,
  canSearchOlder,
  createCoalescedRunner,
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
