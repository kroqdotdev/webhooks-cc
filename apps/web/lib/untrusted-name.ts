/**
 * A name someone other than the reader chose (an agent's own client name, an
 * OAuth client's name, a team's name a key can change), made fit to show on
 * a page or in an email where it must never read as part of the sentence
 * around it: quotes, control and formatting characters (bidi overrides,
 * zero-width characters), line and paragraph separators, private-use and
 * lone surrogate code points, combining marks (which can stack over the
 * text beside them) and the Hangul fillers that draw nothing are removed,
 * runs of whitespace become one space, and the result is cut to `max` code
 * points, so a surrogate pair is never split. Empty when nothing is left.
 * Scripts that write vowels as combining marks lose them: a label that may
 * read oddly is the price of one that cannot be made to read as something
 * else.
 */
export function cleanUntrustedName(name: string, max: number): string {
  // Composed first, so an accent typed as a combining mark stays on its letter.
  const cleaned = name
    .normalize("NFC")
    .replace(
      /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Mn}\p{Me}"'`\u201C\u201D\u2018\u2019\u201E\u201F\u2039\u203A\u00AB\u00BB\u115F\u1160\u3164\uFFA0]/gu,
      ""
    )
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(cleaned).slice(0, max).join("").trim();
}
