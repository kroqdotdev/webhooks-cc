/**
 * Text for the generated Open Graph images (lib/og/image.tsx).
 *
 * The image renderer behind next/og fetches what it cannot draw: emoji from a
 * CDN and fonts for other scripts from Google Fonts. Titles are cleaned here
 * down to what the bundled IBM Plex files cover, so an image never needs the
 * network, at build time or at request time.
 */

/** The width of the title column, in pixels (see the layout in image.tsx). */
export const OG_TITLE_WIDTH = 1008;

/**
 * Rough advance widths of IBM Plex Sans SemiBold, as shares of the font size.
 * Each is on the wide side on purpose: a line estimated to fit must fit.
 */
function glyphEm(char: string): number {
  if (char === " ") return 0.26;
  if ("WM@%".includes(char)) return 0.98;
  if ("mw".includes(char)) return 0.88;
  if ("iljI.,:;'!|".includes(char)) return 0.32;
  if ('ftr()[]-"/'.includes(char)) return 0.42;
  if (char >= "0" && char <= "9") return 0.63;
  if (char !== char.toLowerCase()) return 0.72;
  return 0.59;
}

/** The estimated width of a line, in ems. */
export function textEm(text: string): number {
  let width = 0;
  for (const char of text) width += glyphEm(char);
  return width;
}

const ELLIPSIS = "...";

function drawable(codePoint: number): boolean {
  // Printable ASCII, Latin-1 and Latin Extended-A.
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true;
  if (codePoint >= 0xa1 && codePoint <= 0x17f) return codePoint !== 0xad;
  // Dashes, curly quotes, bullet, ellipsis, euro, trademark, right arrow.
  return [
    0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x20ac, 0x2122, 0x2192,
  ].includes(codePoint);
}

/** Keeps the characters the bundled fonts can draw and tidies the spaces. */
export function ogText(input: string): string {
  let out = "";
  for (const char of input.normalize("NFC")) {
    const codePoint = char.codePointAt(0)!;
    // Every kind of space, tab and line break becomes one plain space.
    if (/\s/u.test(char)) out += " ";
    else if (drawable(codePoint)) out += char;
  }
  return out.replace(/ +/g, " ").trim();
}

/** The longest start of `text` that is no wider than `maxEm`. */
function headWithin(text: string, maxEm: number): string {
  let width = 0;
  let end = 0;
  for (const char of text) {
    width += glyphEm(char);
    if (width > maxEm) break;
    end += char.length;
  }
  // Always at least one character, so splitting a word makes progress.
  return text.slice(0, Math.max(end, 1));
}

/** Greedy word wrap by estimated width; a word wider than a line is split. */
export function wrapLines(text: string, maxEm: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (let word of text.split(" ")) {
    if (!word) continue;
    while (textEm(word) > maxEm) {
      if (line) {
        lines.push(line);
        line = "";
      }
      const head = headWithin(word, maxEm);
      lines.push(head);
      word = word.slice(head.length);
    }
    if (!word) continue;
    if (!line) line = word;
    else if (textEm(`${line} ${word}`) <= maxEm) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export interface FittedTitle {
  /** One entry per line, in order. */
  lines: string[];
  fontSize: number;
}

interface Step {
  fontSize: number;
  maxLines: number;
}

// Largest first. Each step's lines fit the height left for the title: about
// 240px beside a subtitle, about 290px without one (line height 1.12).
const STEPS_WITH_SUBTITLE: readonly Step[] = [
  { fontSize: 80, maxLines: 2 },
  { fontSize: 68, maxLines: 3 },
  { fontSize: 58, maxLines: 3 },
  { fontSize: 50, maxLines: 4 },
];
const STEPS_ALONE: readonly Step[] = [
  { fontSize: 80, maxLines: 3 },
  { fontSize: 68, maxLines: 3 },
  { fontSize: 58, maxLines: 4 },
  { fontSize: 50, maxLines: 5 },
];

/**
 * Picks the largest size at which the title fits its box, wrapping as it goes.
 * A title too long for the smallest size is cut at a word and ends in "...".
 */
export function fitTitle(title: string, options: { subtitle?: boolean } = {}): FittedTitle {
  const steps = options.subtitle ? STEPS_WITH_SUBTITLE : STEPS_ALONE;
  const text = ogText(title);
  for (const step of steps) {
    const lines = wrapLines(text, OG_TITLE_WIDTH / step.fontSize);
    if (lines.length <= step.maxLines) return { lines, fontSize: step.fontSize };
  }

  const smallest = steps[steps.length - 1];
  const maxEm = OG_TITLE_WIDTH / smallest.fontSize;
  const lines = wrapLines(text, maxEm).slice(0, smallest.maxLines);
  const last = lines[lines.length - 1];
  let cut = headWithin(last, maxEm - textEm(ELLIPSIS));
  // Prefer ending on a whole word when the cut fell inside one.
  if (cut.length < last.length && cut.includes(" ")) cut = cut.slice(0, cut.lastIndexOf(" "));
  lines[lines.length - 1] = `${cut.replace(/[\s.,:;!?-]+$/, "")}${ELLIPSIS}`;
  return { lines, fontSize: smallest.fontSize };
}
