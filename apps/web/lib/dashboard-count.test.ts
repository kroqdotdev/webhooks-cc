import { describe, expect, test } from "vitest";

import {
  buildRetainedCountParams,
  computeShowHasMore,
  incrementRetainedCount,
} from "./dashboard-count";

describe("buildRetainedCountParams", () => {
  test("includes only slug when no filters are active", () => {
    expect(buildRetainedCountParams("demo", "ALL", "")).toEqual({ slug: "demo" });
  });

  test("includes method and search query when active", () => {
    expect(buildRetainedCountParams("demo", "POST", "needle")).toEqual({
      slug: "demo",
      method: "POST",
      q: "needle",
    });
  });
});

describe("incrementRetainedCount", () => {
  test("increments when count is known and matched rows are positive", () => {
    expect(incrementRetainedCount(10, 3)).toBe(13);
  });

  test("does not change unknown counts", () => {
    expect(incrementRetainedCount(null, 3)).toBeNull();
  });

  test("does not change count for zero or negative matches", () => {
    expect(incrementRetainedCount(10, 0)).toBe(10);
    expect(incrementRetainedCount(10, -2)).toBe(10);
  });
});

describe("computeShowHasMore", () => {
  test("hides load more while searching", () => {
    expect(
      computeShowHasMore({
        searchQuery: "abc",
        hasMoreFromPagination: true,
        retainedTotalCount: 999,
        loadedCount: 10,
        hasLoadedOlderPage: false,
        initialCanLoadMore: true,
      })
    ).toBe(false);
  });

  test("shows load more when pagination reports more rows", () => {
    expect(
      computeShowHasMore({
        searchQuery: "",
        hasMoreFromPagination: true,
        retainedTotalCount: null,
        loadedCount: 50,
        hasLoadedOlderPage: true,
        initialCanLoadMore: false,
      })
    ).toBe(true);
  });

  test("uses retained total count when available", () => {
    expect(
      computeShowHasMore({
        searchQuery: "",
        hasMoreFromPagination: false,
        retainedTotalCount: 101,
        loadedCount: 100,
        hasLoadedOlderPage: true,
        initialCanLoadMore: false,
      })
    ).toBe(true);

    expect(
      computeShowHasMore({
        searchQuery: "",
        hasMoreFromPagination: false,
        retainedTotalCount: 100,
        loadedCount: 100,
        hasLoadedOlderPage: true,
        initialCanLoadMore: true,
      })
    ).toBe(false);
  });

  test("falls back to first-page heuristic when retained total is unknown", () => {
    expect(
      computeShowHasMore({
        searchQuery: "",
        hasMoreFromPagination: false,
        retainedTotalCount: null,
        loadedCount: 50,
        hasLoadedOlderPage: false,
        initialCanLoadMore: true,
      })
    ).toBe(true);

    expect(
      computeShowHasMore({
        searchQuery: "",
        hasMoreFromPagination: false,
        retainedTotalCount: null,
        loadedCount: 50,
        hasLoadedOlderPage: true,
        initialCanLoadMore: true,
      })
    ).toBe(false);
  });
});
