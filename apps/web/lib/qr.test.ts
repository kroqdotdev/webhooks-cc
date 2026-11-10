import { describe, expect, it } from "vitest";
import { encode } from "uqr";
import { qrPath } from "./qr";

describe("qrPath", () => {
  it("draws every dark module once, inside the code's size", () => {
    const text = "https://acme-demo.sharehooks.cc";
    const { size, d } = qrPath(text);
    const { data } = encode(text, { ecc: "M", border: 2 });
    const dark = data.flat().filter(Boolean).length;
    let drawn = 0;
    for (const match of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
      const [, x, y, w, back] = match.map(Number);
      expect(back).toBe(w);
      expect(x + w).toBeLessThanOrEqual(size);
      expect(y).toBeLessThan(size);
      drawn += w;
    }
    expect(drawn).toBe(dark);
    expect(size).toBeGreaterThan(20);
  });
});
