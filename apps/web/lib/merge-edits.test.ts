import { describe, expect, it } from "vitest";
import { mergeEdits } from "./merge-edits";

type Item = { id: string; value: string };
const byId = (item: Item) => item.id;
const a = { id: "a", value: "1" };
const b = { id: "b", value: "1" };

describe("mergeEdits", () => {
  it("takes the saved copy where nothing was edited here", () => {
    expect(mergeEdits([a, b], [a, b], [{ ...a, value: "2" }, b], byId)).toEqual([
      { ...a, value: "2" },
      b,
    ]);
  });

  it("keeps an edit made here, and the change made elsewhere to another item", () => {
    expect(
      mergeEdits([a, b], [a, { ...b, value: "mine" }], [{ ...a, value: "repaired" }, b], byId)
    ).toEqual([
      { ...a, value: "repaired" },
      { ...b, value: "mine" },
    ]);
  });

  it("keeps items added or removed here, and adds and drops what changed elsewhere", () => {
    const c = { id: "c", value: "new here" };
    const d = { id: "d", value: "new there" };
    // Here: b removed, c added. There: a removed, d added.
    expect(mergeEdits([a, b], [a, c], [b, d], byId)).toEqual([c, d]);
  });
});
