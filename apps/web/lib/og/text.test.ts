import { describe, expect, it } from "vitest";
import { OG_TITLE_WIDTH, fitTitle, ogText, textEm, wrapLines } from "./text";

describe("ogText", () => {
  it("keeps Latin text and common punctuation", () => {
    expect(ogText("Café – “Stripe” vs ngrok: 100% (2026)")).toBe(
      "Café – “Stripe” vs ngrok: 100% (2026)"
    );
  });

  it("drops emoji and scripts the bundled fonts do not cover", () => {
    // Either would make the renderer fetch an emoji image or a font.
    expect(ogText("Ship it \u{1F680} now")).toBe("Ship it now");
    expect(ogText("Webhooks 中文 guide")).toBe("Webhooks guide");
    // A zero-width joiner and a variation selector, as emoji sequences carry.
    expect(ogText(`a${String.fromCodePoint(0x200d)}b${String.fromCodePoint(0xfe0f)}`)).toBe("ab");
  });

  it("turns every kind of whitespace into single spaces", () => {
    expect(ogText(`  one\n two\t${String.fromCodePoint(0xa0)}three  `)).toBe("one two three");
  });
});

describe("wrapLines", () => {
  it("wraps at words and splits a word wider than a line", () => {
    const three = textEm("aaa bbb");
    expect(wrapLines("aaa bbb ccc", three)).toEqual(["aaa bbb", "ccc"]);
    expect(wrapLines("abcdefghxx yz", textEm("abcd"))).toEqual(["abcd", "efgh", "xx", "yz"]);
    expect(wrapLines("", 10)).toEqual([]);
  });

  it("counts wide letters as wide", () => {
    expect(textEm("WWWW")).toBeGreaterThan(textEm("aaaa"));
    expect(textEm("aaaa")).toBeGreaterThan(textEm("iiii"));
    // Narrower than one glyph: still one glyph a line, never an endless loop.
    expect(wrapLines("WW", 0.1)).toEqual(["W", "W"]);
  });
});

describe("fitTitle", () => {
  const fits = (title: string, subtitle: boolean) => {
    const { lines, fontSize } = fitTitle(title, { subtitle });
    for (const line of lines) {
      expect(textEm(line) * fontSize).toBeLessThanOrEqual(OG_TITLE_WIDTH);
    }
    // The title's box: 240px beside a subtitle, 290px alone.
    expect(lines.length * fontSize * 1.12).toBeLessThanOrEqual(subtitle ? 240 : 290);
    return { lines, fontSize };
  };

  it("sets a short title at the largest size", () => {
    expect(fits("webhooks.cc vs ngrok", true)).toEqual({
      lines: ["webhooks.cc vs ngrok"],
      fontSize: 80,
    });
  });

  it("shrinks as the title grows", () => {
    const medium = fits("How to test Stripe webhooks locally without exposing a port", false);
    const long = fits(
      "How to test Stripe webhooks locally without exposing a port, verify every signature in CI and replay failed deliveries from the command line",
      false
    );
    expect(medium.fontSize).toBeGreaterThan(long.fontSize);
    expect(long.lines.join(" ")).toContain("command line");
  });

  it("cuts a title that fits at no size and marks the cut", () => {
    const { lines, fontSize } = fits("word ".repeat(120), true);
    expect(fontSize).toBe(50);
    expect(lines).toHaveLength(4);
    expect(lines[3].endsWith("...")).toBe(true);
    expect(lines[3]).not.toMatch(/ \.\.\.$/);
  });

  it("keeps one unbroken string inside the box", () => {
    for (const char of ["x", "W", "i"]) {
      const { lines } = fits(char.repeat(600), false);
      expect(lines[lines.length - 1].endsWith("...")).toBe(true);
    }
  });

  it("cleans the title before measuring it", () => {
    expect(fitTitle("Launch \u{1F389} day").lines).toEqual(["Launch day"]);
  });
});
