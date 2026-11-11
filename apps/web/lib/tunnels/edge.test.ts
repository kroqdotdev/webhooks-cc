import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({
  tunnelConfig: () => ({
    edgeSecret: "x".repeat(32),
    edgeUrl: "http://edge.test:4001",
    previewOrigin: new URL("https://sharehooks.test"),
  }),
}));

import { CLOSES_PER_REQUEST, closeOnEdge, type EdgeClose } from "./edge";

function closes(count: number): EdgeClose[] {
  return Array.from({ length: count }, (_, i) => ({
    shareId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    // About as long as the words a CLI is told.
    reason: "w".repeat(250),
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("closeOnEdge", () => {
  it("sends a bulk stop in parts that fit the control port's 64 KiB", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return new Response("{}", { status: 200 });
      })
    );
    const all = closes(250);
    expect(await closeOnEdge(all)).toBe(true);
    expect(bodies).toHaveLength(Math.ceil(250 / CLOSES_PER_REQUEST));
    for (const body of bodies)
      expect(new TextEncoder().encode(body).length).toBeLessThan(64 * 1024);
    const sent = bodies.flatMap((b) => (JSON.parse(b) as { closes: EdgeClose[] }).closes);
    expect(sent.map((c) => c.shareId)).toEqual(all.map((c) => c.shareId));
  });

  it("says the edge was not reached when any part failed, and still sends the rest", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response("no", { status: calls === 1 ? 500 : 200 });
      })
    );
    expect(await closeOnEdge(closes(150))).toBe(false);
    expect(calls).toBe(2);
  });

  it("sends nothing for no closes", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await closeOnEdge([])).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
