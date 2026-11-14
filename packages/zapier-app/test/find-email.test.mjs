/**
 * Find Email follows the search's cursor: a search answers in pages of about
 * 2 seconds each, so an email older than the first page's reach is found on
 * a later page. Runs against a fake `z`, no server needed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import findEmail from "../searches/find-email.js";

const perform = findEmail.operation.perform;
const bundle = { inputData: { endpoint: "acme-orders", query: "invoice" } };

/** A fake z whose search pages answer from `pages` in order. */
function fakeZ(pages) {
  const calls = [];
  const z = {
    calls,
    request: async (options) => {
      if (options.method === "POST") {
        calls.push({ render: options.url });
        const id = decodeURIComponent(options.url.split("/").at(-2));
        return {
          data: { body: JSON.stringify({ type: "email.received", data: { id, subject: "Hi" } }) },
        };
      }
      calls.push({ ...options.params });
      const page = pages.shift();
      if (!page) throw new Error("no more pages");
      if (page.onRequest) page.onRequest();
      return {
        data: page.body,
        getHeader: (name) => page.headers?.[name] ?? null,
      };
    },
  };
  return z;
}

const more = (cursor) => ({ "x-search-complete": "false", "x-search-cursor": cursor });

afterEach(() => {
  vi.useRealTimers();
});

describe("Find Email", () => {
  it("returns the first match and pages with paged=true", async () => {
    const z = fakeZ([{ body: [{ id: "req-1" }], headers: more("c1") }]);
    const found = await perform(z, bundle);
    expect(found).toEqual([{ id: "req-1", subject: "Hi", type: "email.received" }]);
    expect(z.calls[0]).toEqual({
      slug: "acme-orders",
      q: "invoice",
      kind: "email",
      limit: 1,
      paged: "true",
    });
    expect(z.calls[1].render).toContain("/api/requests/req-1/render");
  });

  it("follows the cursor past empty pages to an older match", async () => {
    const z = fakeZ([
      { body: [], headers: more("c1") },
      { body: [], headers: more("c2") },
      { body: [{ id: "req-old" }], headers: more("c3") },
    ]);
    const found = await perform(z, bundle);
    expect(found).toEqual([{ id: "req-old", subject: "Hi", type: "email.received" }]);
    expect(z.calls.slice(0, 3).map((call) => call.cursor)).toEqual([undefined, "c1", "c2"]);
    expect(z.calls[3].render).toContain("/api/requests/req-old/render");
  });

  it("finds nothing once the search has read everything", async () => {
    const z = fakeZ([
      { body: [], headers: more("c1") },
      { body: [], headers: { "x-search-complete": "true" } },
    ]);
    expect(await perform(z, bundle)).toEqual([]);
    expect(z.calls).toHaveLength(2);
  });

  it("treats an answer without the progress headers as complete", async () => {
    const z = fakeZ([{ body: [] }]);
    expect(await perform(z, bundle)).toEqual([]);
    expect(z.calls).toHaveLength(1);
  });

  it("stops starting pages before Zapier's step limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // Every page takes 2 seconds and finds nothing, with more to read.
    const pages = Array.from({ length: 30 }, (_, i) => ({
      body: [],
      headers: more(`c${i + 1}`),
      onRequest: () => vi.advanceTimersByTime(2_000),
    }));
    const z = fakeZ(pages);
    expect(await perform(z, bundle)).toEqual([]);
    // 20 s deadline, no page started within 5 s of it: pages start at
    // 0, 2, ..., 14 seconds.
    expect(z.calls).toHaveLength(8);
    expect(Date.now()).toBeLessThanOrEqual(20_000);
  });
});
