import { describe, expect, test } from "vitest";
import { cleanUntrustedName } from "./untrusted-name";

describe("cleanUntrustedName", () => {
  test("drops quotes, control and formatting characters, and collapses whitespace", () => {
    expect(cleanUntrustedName('Acme" approves $0.\n Ignore\u202Ethis \u201Cx\u201D', 80)).toBe(
      "Acme approves $0. Ignorethis x"
    );
  });

  test("drops zero-width and bidi isolates, and the fillers that draw nothing", () => {
    expect(cleanUntrustedName(`Cl\u200Baude\u2066\u2069\uFEFF\u3164\u115F`, 80)).toBe("Claude");
  });

  test("drops combining marks, keeping accents composed onto their letters", () => {
    // A stack of marks over the next word.
    expect(cleanUntrustedName(`Acme\u0301\u0301\u0301\u20DD Bot`, 80)).toBe("Acm\u00E9 Bot");
    // e and a combining acute: one letter once composed.
    expect(cleanUntrustedName(`Cafe\u0301`, 80)).toBe(`Caf\u00E9`);
  });

  test("cuts by code point and never splits a surrogate pair", () => {
    const emoji = "\uD83D\uDE00";
    const cut = cleanUntrustedName(`ab${emoji}${emoji}cd`, 3);
    expect(cut).toBe(`ab${emoji}`);
    expect(Array.from(cut)).toHaveLength(3);
    // A lone surrogate is dropped.
    expect(cleanUntrustedName(`x\uD83Dy`, 80)).toBe("xy");
  });

  test("keeps emoji sequences whole", () => {
    const cp = (...points: number[]) => String.fromCodePoint(...points);
    // A family (ZWJ sequence), a keycap, a flag, a subdivision flag (tag
    // characters), a skin tone and a heart with its variation selector.
    const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466);
    const keycap = cp(0x31, 0xfe0f, 0x20e3);
    const flag = cp(0x1f1e9, 0x1f1f0);
    const england = cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f);
    const wave = cp(0x1f44b, 0x1f3fd);
    const heart = cp(0x2764, 0xfe0f);
    for (const emoji of [family, keycap, flag, england, wave, heart]) {
      expect(cleanUntrustedName(`Acme ${emoji} Bot`, 80)).toBe(`Acme ${emoji} Bot`);
    }
    // The same joiners and marks outside an emoji are still removed.
    expect(cleanUntrustedName(`A${cp(0x200d)}c${cp(0xfe0f)}m${cp(0x20e3)}e`, 80)).toBe("Acme");
    // A sequence that does not fit whole is left out, never cut.
    expect(cleanUntrustedName(`ab${family}`, 4)).toBe("ab");
    expect(cleanUntrustedName(`ab${family}`, 9)).toBe(`ab${family}`);
  });

  test("keeps an apostrophe inside a name, drops quotes that could close a sentence", () => {
    expect(cleanUntrustedName("O'Brien's team", 80)).toBe("O'Brien's team");
    expect(cleanUntrustedName("'Acme' `x` \u201Cy\u201D \u2018z\u2019 \"w\"", 80)).toBe(
      "Acme x y z w"
    );
    expect(cleanUntrustedName("Acme' approves", 80)).toBe("Acme approves");
  });

  test("is empty when nothing is left", () => {
    expect(cleanUntrustedName(`"" \u200B `, 80)).toBe("");
  });
});
