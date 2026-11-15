import { describe, expect, it } from "vitest";
import { cutAtLimit, pinUntil } from "./cut";

const at = (iso: string, id: string) => ({ id, received_at: iso });

describe("cutAtLimit", () => {
  it("answers no nextSince when the range fit", () => {
    const rows = [at("2026-11-15T10:00:00.001Z", "a"), at("2026-11-15T10:00:00.002Z", "b")];
    expect(cutAtLimit(rows, 2)).toEqual({ rows, nextSince: null });
    expect(cutAtLimit(rows.slice(0, 1), 2)).toEqual({ rows: rows.slice(0, 1), nextSince: null });
  });

  it("goes on from the next row's millisecond", () => {
    const rows = [
      at("2026-11-15T10:00:00.001Z", "a"),
      at("2026-11-15T10:00:00.002Z", "b"),
      at("2026-11-15T10:00:00.003Z", "c"),
    ];
    const cut = cutAtLimit(rows, 2);
    expect(cut.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(cut.nextSince).toBe(Date.parse("2026-11-15T10:00:00.003Z"));
  });

  it("leaves rows sharing the next row's millisecond for the next call", () => {
    // Microseconds, as Postgres stores them: b and c share a millisecond
    // with d, the row past the limit.
    const rows = [
      at("2026-11-15T10:00:00.001000+00:00", "a"),
      at("2026-11-15T10:00:00.002100+00:00", "b"),
      at("2026-11-15T10:00:00.002500+00:00", "c"),
      at("2026-11-15T10:00:00.002900+00:00", "d"),
    ];
    const cut = cutAtLimit(rows, 3);
    expect(cut.rows.map((r) => r.id)).toEqual(["a"]);
    expect(cut.nextSince).toBe(Date.parse("2026-11-15T10:00:00.002Z"));
  });

  it("never answers an empty batch that would repeat forever", () => {
    const rows = ["a", "b", "c"].map((id) => at("2026-11-15T10:00:00.005Z", id));
    const cut = cutAtLimit(rows, 2);
    expect(cut.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(cut.nextSince).toBe(Date.parse("2026-11-15T10:00:00.005Z") + 1);
  });

  it("skips the extra rows of a millisecond holding more than the limit", () => {
    // Documented: a and b replay, c (same millisecond) is past the
    // continuation's start, d is next.
    const rows = [
      at("2026-11-15T10:00:00.005Z", "a"),
      at("2026-11-15T10:00:00.005Z", "b"),
      at("2026-11-15T10:00:00.005Z", "c"),
      at("2026-11-15T10:00:00.006Z", "d"),
    ];
    const cut = cutAtLimit(rows, 2);
    expect(cut.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(cut.nextSince).toBe(Date.parse("2026-11-15T10:00:00.006Z"));
  });
});

describe("pinUntil", () => {
  it("keeps an until given and pins a missing one to now", () => {
    expect(pinUntil(42, 1000)).toBe(42);
    expect(pinUntil(0, 1000)).toBe(0);
    expect(pinUntil(null, 1000)).toBe(1000);
    expect(pinUntil(undefined, 1000)).toBe(1000);
  });
});
