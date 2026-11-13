import { describe, expect, it } from "vitest";
import type { RequestCursor, RequestRecord } from "@/lib/supabase/requests";
import { createStreamDrainer, type StreamDrainerDeps } from "./drainer";

/** A fake endpoint: rows as the database holds them, read like the real queries. */
function fakeStore() {
  const rows: { id: string; at: number }[] = [];
  const iso = (ms: number) => new Date(ms).toISOString();
  const record = (row: { id: string; at: number }) =>
    ({ id: row.id, receivedAt: row.at, path: `/${row.id}` }) as unknown as RequestRecord;
  const after = (row: { id: string; at: number }, cursor: RequestCursor) => {
    const at = Date.parse(cursor.receivedAt);
    return row.at > at || (row.at === at && row.id > cursor.id);
  };
  let failByIds = 0;
  let gone = false;
  const calls = { byIds: [] as string[][], window: 0 };
  return {
    insert(id: string, at: number) {
      rows.push({ id, at });
    },
    failNextByIds() {
      failByIds += 1;
    },
    deleteEndpoint() {
      gone = true;
    },
    calls,
    deps(overrides: Partial<StreamDrainerDeps> = {}) {
      const sent: string[] = [];
      const scheduled: (() => void)[] = [];
      let closed = false;
      const errors: unknown[] = [];
      const deps: StreamDrainerDeps = {
        afterTimestamp: 0,
        pageSize: 2,
        lateWindowMs: 60_000,
        readAfter: async ({ after: since, cursor, limit }) => {
          if (gone) return null;
          const page = rows
            .filter((row) => (cursor ? after(row, cursor) : row.at > since))
            .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
            .slice(0, limit);
          const last = page[page.length - 1];
          return {
            records: page.map(record),
            cursor: last ? { receivedAt: iso(last.at), id: last.id } : cursor,
          };
        },
        readByIds: async (ids) => {
          calls.byIds.push(ids);
          if (failByIds > 0) {
            failByIds -= 1;
            throw new Error("database busy");
          }
          return rows.filter((row) => ids.includes(row.id)).map(record);
        },
        readIdsInWindow: async (from, to, limit) => {
          calls.window += 1;
          const until = Date.parse(to);
          return rows
            .filter((row) => row.at > from && row.at <= until)
            .sort((a, b) => b.at - a.at)
            .slice(0, limit)
            .map((row) => row.id);
        },
        schedule: (run) => scheduled.push(run),
        send: (r) => sent.push(r.id),
        gone: () => {
          closed = true;
          sent.push("<gone>");
        },
        isClosed: () => closed,
        onError: (error) => errors.push(error),
        ...overrides,
      };
      return { deps, sent, errors, scheduled };
    },
  };
}

describe("createStreamDrainer", () => {
  it("sends the backlog in order, page by page, once each", async () => {
    const store = fakeStore();
    for (const [i, id] of ["a", "b", "c", "d", "e"].entries()) store.insert(id, 1_000 + i);
    const { deps, sent } = store.deps();
    const drainer = createStreamDrainer(deps);
    await drainer.drain();
    await drainer.drain();
    expect(sent).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("sends requests that arrive while it reads, without repeats", async () => {
    const store = fakeStore();
    for (const [i, id] of ["a", "b", "c"].entries()) store.insert(id, 1_000 + i);
    const { deps, sent } = store.deps();
    let reads = 0;
    const readAfter = deps.readAfter;
    deps.readAfter = async (input) => {
      reads += 1;
      // A request lands between the first and second page.
      if (reads === 2) store.insert("new", 2_000);
      return readAfter(input);
    };
    const drainer = createStreamDrainer(deps);
    await drainer.drain();
    expect(sent).toEqual(["a", "b", "c", "new"]);
  });

  it("sends a request that commits behind the cursor when its signal comes", async () => {
    const store = fakeStore();
    store.insert("newer", 2_000);
    const { deps, sent } = store.deps();
    const drainer = createStreamDrainer(deps);
    await drainer.drain();
    // Stamped before "newer", committed after it.
    store.insert("late", 1_500);
    drainer.signal("late");
    await drainer.drain();
    expect(sent).toEqual(["newer", "late"]);
  });

  it("finds a late request whose signal was lost on the next recheck", async () => {
    const store = fakeStore();
    store.insert("newer", 2_000);
    const { deps, sent } = store.deps();
    const drainer = createStreamDrainer(deps);
    await drainer.drain();
    store.insert("late", 1_500);
    // No signal arrives for it; a plain read cannot see it behind the cursor.
    await drainer.drain();
    expect(sent).toEqual(["newer"]);
    drainer.recheck();
    await drainer.drain();
    expect(sent).toEqual(["newer", "late"]);
  });

  it("does not lose a signalled id whose fetch fails", async () => {
    const store = fakeStore();
    store.insert("newer", 2_000);
    const { deps, sent, errors } = store.deps();
    const drainer = createStreamDrainer(deps);
    await drainer.drain();
    store.insert("late", 1_500);
    store.failNextByIds();
    drainer.signal("late");
    await drainer.drain();
    // The failed fetch keeps the id and asks for a look-back, which finds it.
    expect(errors).toHaveLength(1);
    expect(sent).toEqual(["newer", "late"]);
  });

  it("fetches a kept id on the next read when the look-back is not due", async () => {
    const store = fakeStore();
    store.insert("newer", 2_000);
    const { deps, sent } = store.deps({ now: () => 0 });
    const drainer = createStreamDrainer(deps);
    await drainer.drain();
    drainer.recheck(); // uses up this interval's look-back
    await drainer.drain();
    store.insert("late", 1_500);
    // signal() starts a read and drain() folds a second pass into it: both
    // fail, and the id is kept (two of three attempts).
    store.failNextByIds();
    store.failNextByIds();
    drainer.signal("late");
    await drainer.drain();
    expect(sent).toEqual(["newer"]);
    await drainer.drain();
    expect(sent).toEqual(["newer", "late"]);
  });

  it("falls back to the late window when signals overflow", async () => {
    const store = fakeStore();
    store.insert("newer", 2_000);
    const { deps, sent } = store.deps({ maxPendingSignals: 1 });
    const drainer = createStreamDrainer(deps);
    await drainer.drain();
    store.insert("late-1", 1_500);
    store.insert("late-2", 1_600);
    // The second id does not fit; the overflow forces a late-window read.
    drainer.signal("late-1");
    drainer.signal("late-2");
    await drainer.drain();
    expect(sent.sort()).toEqual(["late-1", "late-2", "newer"]);
  });

  it("looks back by id and fetches only the rows not sent yet", async () => {
    const store = fakeStore();
    store.insert("a", 1_000);
    store.insert("b", 2_000);
    const { deps, sent } = store.deps();
    const drainer = createStreamDrainer(deps);
    await drainer.drain();
    store.insert("late", 1_500);
    store.calls.byIds.length = 0;
    drainer.recheck();
    await drainer.drain();
    expect(sent).toEqual(["a", "b", "late"]);
    expect(store.calls.byIds).toEqual([["late"]]);
  });

  it("looks back at most once an interval for overflowing signals", async () => {
    const store = fakeStore();
    store.insert("a", 1_000);
    let clock = 0;
    const { deps } = store.deps({ maxPendingSignals: 0, now: () => clock });
    const drainer = createStreamDrainer(deps);
    await drainer.drain();
    for (let i = 0; i < 5; i++) {
      drainer.signal(`x${i}`);
      await drainer.drain();
    }
    expect(store.calls.window).toBe(1);
    clock += 30_000;
    drainer.signal("y");
    await drainer.drain();
    expect(store.calls.window).toBe(2);
  });

  it("fetches signalled ids in chunks", async () => {
    const store = fakeStore();
    store.insert("newer", 9_000);
    const { deps, sent } = store.deps({ idChunkSize: 100 });
    const drainer = createStreamDrainer(deps);
    await drainer.drain();
    for (let i = 0; i < 250; i++) {
      store.insert(`late-${String(i).padStart(3, "0")}`, 1_000 + i);
      drainer.signal(`late-${String(i).padStart(3, "0")}`);
    }
    await drainer.drain();
    expect(store.calls.byIds.map((chunk) => chunk.length)).toEqual([100, 100, 50]);
    expect(sent).toHaveLength(251);
  });

  it("gives up on an id after a few failed fetches, and still looks back", async () => {
    const store = fakeStore();
    store.insert("newer", 2_000);
    const { deps, errors, scheduled } = store.deps({ maxFetchAttempts: 2 });
    const drainer = createStreamDrainer(deps);
    await drainer.drain();
    store.failNextByIds();
    store.failNextByIds();
    drainer.signal("missing");
    await drainer.drain();
    await drainer.drain();
    expect(errors).toHaveLength(2);
    // A failure schedules a retry instead of waiting for the next signal.
    expect(scheduled.length).toBeGreaterThan(0);
    store.calls.byIds.length = 0;
    await drainer.drain();
    expect(store.calls.byIds).toEqual([]);
    // A failed fetch asked for a look-back too.
    expect(store.calls.window).toBeGreaterThan(0);
  });

  it("leaves out rows from before the start", async () => {
    const store = fakeStore();
    store.insert("before", 500);
    store.insert("after", 1_500);
    const { deps, sent } = store.deps({ afterTimestamp: 1_000 });
    const drainer = createStreamDrainer(deps);
    drainer.signal("before");
    await drainer.drain();
    drainer.recheck();
    await drainer.drain();
    expect(sent).toEqual(["after"]);
  });

  it("stops when the endpoint is gone", async () => {
    const store = fakeStore();
    store.insert("a", 1_000);
    store.deleteEndpoint();
    const { deps, sent } = store.deps();
    await createStreamDrainer(deps).drain();
    expect(sent).toEqual(["<gone>"]);
  });
});
