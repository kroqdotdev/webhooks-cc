/**
 * Whole emoji sequences (RGI: the ones Unicode recommends for general
 * interchange, so flags, keycaps, skin tones and ZWJ families), which hold
 * characters the cleaning below removes on their own (the zero-width
 * joiner, variation selectors, the keycap mark, tag characters). Built at
 * run time: the `v` flag is newer than the TypeScript target.
 */
const RGI_EMOJI = new RegExp("\\p{RGI_Emoji}", "gv");

/**
 * Everything removed from the text between emoji: control and formatting
 * characters, surrogates and private use, line and paragraph separators,
 * combining marks, the Hangul fillers that draw nothing, and every quote
 * that could close or open a quotation around the name (the straight double
 * quote, the backtick, curly and angle quotes). The ASCII apostrophe is
 * handled on its own (APOSTROPHE).
 */
const REMOVED =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Mn}\p{Me}"`\u201C\u201D\u2018\u2019\u201A\u201B\u201E\u201F\u2039\u203A\u00AB\u00BB\u115F\u1160\u3164\uFFA0]/gu;

/** An ASCII apostrophe that is not inside a word (O'Brien keeps its own). */
const APOSTROPHE = /(?<![\p{L}\p{N}])'|'(?![\p{L}\p{N}])/gu;

/**
 * A name someone other than the reader chose (an agent's own client name, an
 * OAuth client's name, a team's name a key can change), made fit to show on
 * a page or in an email where it must never read as part of the sentence
 * around it: quotes (an apostrophe inside a word, as in O'Brien, stays),
 * control and formatting characters (bidi overrides, zero-width
 * characters), line and paragraph separators, private-use and lone
 * surrogate code points, combining marks (which can stack over the text
 * beside them) and the Hangul fillers that draw nothing are removed, runs of
 * whitespace become one space, and the result is cut to `max` code points.
 * Emoji sequences are kept whole (a family, a flag, a keycap), and the cut
 * never splits one or a surrogate pair: a sequence that does not fit is left
 * out. Empty when nothing is left. Scripts that write vowels as combining
 * marks lose them: a label that may read oddly is the price of one that
 * cannot be made to read as something else.
 */
export function cleanUntrustedName(name: string, max: number): string {
  // Composed first, so an accent typed as a combining mark stays on its letter.
  const text = name.normalize("NFC");
  // Units: one code point of cleaned text, or one whole emoji sequence.
  const units: string[] = [];
  const addText = (part: string) => {
    units.push(...Array.from(part.replace(REMOVED, "").replace(APOSTROPHE, "")));
  };
  let from = 0;
  for (const match of text.matchAll(RGI_EMOJI)) {
    addText(text.slice(from, match.index));
    units.push(match[0]);
    from = match.index + match[0].length;
  }
  addText(text.slice(from));

  // Whitespace runs become one space, none at either end.
  const spaced: string[] = [];
  for (const unit of units) {
    if (/^\s$/u.test(unit)) {
      if (spaced.length > 0 && spaced[spaced.length - 1] !== " ") spaced.push(" ");
    } else {
      spaced.push(unit);
    }
  }
  while (spaced[spaced.length - 1] === " ") spaced.pop();

  let out = "";
  let length = 0;
  for (const unit of spaced) {
    const size = Array.from(unit).length;
    if (length + size > max) break;
    out += unit;
    length += size;
  }
  return out.trim();
}
