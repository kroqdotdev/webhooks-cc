import { afterEach, describe, expect, test, vi } from "vitest";
import {
  SEARCH_MAX_RUNNING,
  SEARCH_MAX_RUNNING_PER_ACCOUNT,
  SearchBusyError,
  searchGateSnapshot,
  withSearchSlot,
} from "./search-gate";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("withSearchSlot", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("runs at once when a slot is free and releases it after", async () => {
    await expect(withSearchSlot("acct-a", async () => 7)).resolves.toBe(7);
    expect(searchGateSnapshot()).toEqual({ running: 0, waiting: 0 });
  });

  test("releases the slot when the search throws", async () => {
    await expect(
      withSearchSlot("acct-a", async () => {
        throw new Error("db");
      })
    ).rejects.toThrow("db");
    expect(searchGateSnapshot().running).toBe(0);
  });

  test("holds an account to its own cap while others still run", async () => {
    const gates = Array.from({ length: SEARCH_MAX_RUNNING_PER_ACCOUNT }, () => deferred());
    const held = gates.map((g) => withSearchSlot("acct-a", () => g.promise));

    // acct-a is at its cap; acct-b runs straight away.
    await expect(withSearchSlot("acct-b", async () => "b")).resolves.toBe("b");

    // A third acct-a search waits, then runs once one of its own finishes.
    let thirdRan = false;
    const third = withSearchSlot("acct-a", async () => {
      thirdRan = true;
    });
    await Promise.resolve();
    expect(thirdRan).toBe(false);
    gates[0].resolve();
    await third;
    expect(thirdRan).toBe(true);

    gates.slice(1).forEach((g) => g.resolve());
    await Promise.all(held);
    expect(searchGateSnapshot()).toEqual({ running: 0, waiting: 0 });
  });

  test("refuses with a retry hint when no slot frees in time", async () => {
    const gates = Array.from({ length: SEARCH_MAX_RUNNING }, () => deferred());
    const held = gates.map((g, i) => withSearchSlot(`acct-${i}`, () => g.promise));

    await expect(withSearchSlot("acct-late", async () => 1, { waitMs: 20 })).rejects.toBeInstanceOf(
      SearchBusyError
    );
    expect(searchGateSnapshot().waiting).toBe(0);

    gates.forEach((g) => g.resolve());
    await Promise.all(held);
    expect(searchGateSnapshot().running).toBe(0);
  });

  test("drops a waiter whose caller goes away, and never starts it", async () => {
    const gates = Array.from({ length: SEARCH_MAX_RUNNING_PER_ACCOUNT }, () => deferred());
    const held = gates.map((g) => withSearchSlot("acct-c", () => g.promise));

    const controller = new AbortController();
    let started = false;
    const waiting = withSearchSlot(
      "acct-c",
      async () => {
        started = true;
      },
      { signal: controller.signal }
    );
    await Promise.resolve();
    expect(searchGateSnapshot().waiting).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(searchGateSnapshot().waiting).toBe(0);

    gates.forEach((g) => g.resolve());
    await Promise.all(held);
    expect(started).toBe(false);
    expect(searchGateSnapshot()).toEqual({ running: 0, waiting: 0 });
  });

  test("refuses at once when the caller has already gone", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withSearchSlot("acct-d", async () => 1, { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(searchGateSnapshot().running).toBe(0);
  });
});
