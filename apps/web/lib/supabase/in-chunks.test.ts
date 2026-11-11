import { describe, expect, it } from "vitest";
import { chunked, IN_CHUNK, inChunks } from "./in-chunks";

describe("chunked", () => {
  it("splits a list into pieces of at most the size, in order", () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunked([], 2)).toEqual([]);
    expect(chunked(Array.from({ length: 1_000 }, (_, i) => i)).map((c) => c.length)).toEqual([
      200, 200, 200, 200, 200,
    ]);
  });
});

describe("inChunks", () => {
  it("runs one query per chunk of at most IN_CHUNK distinct values and joins the rows", async () => {
    const seen: number[] = [];
    const values = Array.from({ length: 1_000 }, (_, i) => `id-${i}`);
    const rows = await inChunks([...values, ...values.slice(0, 10)], async (chunk) => {
      seen.push(chunk.length);
      return { data: chunk.map((id) => ({ id })), error: null };
    });
    expect(Math.max(...seen)).toBeLessThanOrEqual(IN_CHUNK);
    expect(seen).toHaveLength(5);
    expect(rows.map((r) => r.id)).toEqual(values);
  });

  it("runs no query for an empty list and throws the first error", async () => {
    let calls = 0;
    expect(
      await inChunks([], async () => {
        calls += 1;
        return { data: [], error: null };
      })
    ).toEqual([]);
    expect(calls).toBe(0);
    await expect(
      inChunks(["a", "b"], async () => ({ data: null, error: new Error("boom") }), 1)
    ).rejects.toThrow("boom");
  });
});
