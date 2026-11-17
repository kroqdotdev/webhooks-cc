import { describe, expect, it, vi } from "vitest";
import type { DashboardEndpointsResponse } from "./dashboard-api";
import { createEndpointsLoader, type DashboardEndpointsState } from "./dashboard-endpoints-loader";

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function list(...slugs: string[]): DashboardEndpointsResponse {
  return {
    owned: slugs.map((slug) => ({ id: slug, slug, name: slug })),
    shared: [],
  } as unknown as DashboardEndpointsResponse;
}

/** A loader whose claim and list answers the test hands out one at a time. */
function harness() {
  let state: DashboardEndpointsState | null = null;
  const claims: ReturnType<typeof deferred<void>>[] = [];
  const fetches: ReturnType<typeof deferred<DashboardEndpointsResponse>>[] = [];
  const claim = vi.fn(() => {
    const d = deferred<void>();
    claims.push(d);
    return d.promise;
  });
  const fetchList = vi.fn(() => {
    const d = deferred<DashboardEndpointsResponse>();
    fetches.push(d);
    return d.promise;
  });
  const loader = createEndpointsLoader({
    claim,
    fetchList,
    setState: (update) => {
      state = update(state);
    },
  });
  return { loader, claims, fetches, claim, fetchList, state: () => state };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createEndpointsLoader", () => {
  it("lists only after the guest claim, for every load started meanwhile", async () => {
    const h = harness();
    const first = h.loader.reload("token", "u1");
    const second = h.loader.reload("token", "u1");
    await flush();
    // Neither load lists before the claim lands: an empty list would make
    // the dashboard create a second endpoint.
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.fetchList).not.toHaveBeenCalled();

    h.claims[0].resolve();
    await flush();
    expect(h.fetchList).toHaveBeenCalledTimes(2);
    h.fetches[0].resolve(list());
    h.fetches[1].resolve(list("claimed"));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(h.state()?.data).toEqual(list("claimed"));
  });

  it("claims again for another account, and not again for the same one", async () => {
    const h = harness();
    const a = h.loader.reload("token-a", "u1");
    h.claims[0].resolve();
    await flush();
    h.fetches[0].resolve(list("a"));
    await a;

    const again = h.loader.reload("token-a", "u1");
    await flush();
    h.fetches[1].resolve(list("a"));
    await again;
    expect(h.claim).toHaveBeenCalledTimes(1);

    const b = h.loader.reload("token-b", "u2");
    await flush();
    expect(h.claim).toHaveBeenCalledTimes(2);
    h.claims[1].resolve();
    await flush();
    h.fetches[2].resolve(list("b"));
    await b;
    expect(h.state()).toEqual({ userId: "u2", data: list("b"), failed: false });
  });

  it("keeps the newest list when an older load answers last", async () => {
    const h = harness();
    const older = h.loader.reload("token", "u1");
    h.claims[0].resolve();
    await flush();
    const newer = h.loader.reload("token", "u1");
    await flush();
    expect(h.fetches).toHaveLength(2);

    h.fetches[1].resolve(list("starred"));
    await flush();
    h.fetches[0].resolve(list("before the star"));
    await Promise.all([older, newer]);
    expect(h.state()?.data).toEqual(list("starred"));
  });

  it("settles a reload with the newest load, not its own", async () => {
    const h = harness();
    const older = h.loader.reload("token", "u1");
    h.claims[0].resolve();
    await flush();
    const newer = h.loader.reload("token", "u1");
    await flush();

    let olderSettled = false;
    void older.then(() => (olderSettled = true));
    h.fetches[0].resolve(list("old"));
    await flush();
    // Its own load is done, but a newer one is still on its way.
    expect(olderSettled).toBe(false);

    h.fetches[1].reject(new Error("down"));
    expect(await older).toBe(false);
    expect(await newer).toBe(false);
  });

  it("reports a first load that failed instead of an empty list", async () => {
    const h = harness();
    const load = h.loader.reload("token", "u1");
    h.claims[0].resolve();
    await flush();
    h.fetches[0].reject(new Error("503"));
    expect(await load).toBe(false);
    // Not { owned: [], shared: [] }: that is the first-endpoint screen, which
    // creates an endpoint on its own.
    expect(h.state()).toEqual({ userId: "u1", failed: true });

    const retry = h.loader.reload("token", "u1");
    await flush();
    h.fetches[1].resolve(list("a"));
    expect(await retry).toBe(true);
    expect(h.state()).toEqual({ userId: "u1", data: list("a"), failed: false });
  });

  it("keeps the list it had when a later load fails", async () => {
    const h = harness();
    const first = h.loader.reload("token", "u1");
    h.claims[0].resolve();
    await flush();
    h.fetches[0].resolve(list("a"));
    await first;

    const later = h.loader.reload("token", "u1");
    await flush();
    h.fetches[1].reject(new Error("503"));
    expect(await later).toBe(false);
    expect(h.state()).toEqual({ userId: "u1", data: list("a"), failed: false });
  });

  it("shows an older list when the newer load failed and nothing newer arrived", async () => {
    const h = harness();
    const first = h.loader.reload("token", "u1");
    h.claims[0].resolve();
    await flush();
    const second = h.loader.reload("token", "u1");
    await flush();
    h.fetches[1].reject(new Error("503"));
    await flush();
    expect(h.state()).toEqual({ userId: "u1", failed: true });
    h.fetches[0].resolve(list("a"));
    await Promise.all([first, second]);
    // A list arrived after all: it beats the failure screen.
    expect(h.state()).toEqual({ userId: "u1", data: list("a"), failed: false });
  });

  it("never lets an older list replace a newer one, nor another account's", async () => {
    const h = harness();
    const a1 = h.loader.reload("token", "u1");
    h.claims[0].resolve();
    await flush();
    const a2 = h.loader.reload("token", "u1");
    await flush();
    h.fetches[1].resolve(list("newer"));
    await flush();
    h.fetches[0].resolve(list("older"));
    await Promise.all([a1, a2]);
    expect(h.state()?.data).toEqual(list("newer"));

    // Another account signs in while the first one's load is on its way.
    const stale = h.loader.reload("token", "u1");
    await flush();
    const b = h.loader.reload("token-b", "u2");
    await flush();
    h.claims[1].resolve();
    await flush();
    h.fetches[2].resolve(list("u1 list"));
    await flush();
    expect(h.state()?.userId).toBe("u1");
    expect(h.state()?.data).toEqual(list("newer"));
    h.fetches[3].resolve(list("u2 list"));
    await Promise.all([stale, b]);
    expect(h.state()).toEqual({ userId: "u2", data: list("u2 list"), failed: false });
  });

  it("still lists when the claim fails", async () => {
    const h = harness();
    const load = h.loader.reload("token", "u1");
    h.claims[0].reject(new Error("claim failed"));
    await flush();
    expect(h.fetchList).toHaveBeenCalledTimes(1);
    h.fetches[0].resolve(list("a"));
    expect(await load).toBe(true);
  });
});
