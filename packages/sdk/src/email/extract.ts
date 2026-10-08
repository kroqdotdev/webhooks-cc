import type { EmailCapture, EmailExtracts, ExtractedLink } from "./types";

/*
 * Every scan here takes time linear in its input. Email HTML and text come
 * from anyone who can send mail, run on the server for forwarding, and can
 * be 256 KB each, so a pattern that backtracks (an unbounded quantifier next
 * to another that matches the same characters, or one that fails at every
 * start position) would let one message stall the process for minutes.
 * Tag and anchor handling is done with indexOf scans for that reason, and
 * extract.test.ts checks adversarial inputs.
 */

/**
 * Finds the one-time codes and links in a captured email: the dashboard's
 * "Found in this email" strip, the `codes` and `links` of forwarded JSON,
 * and the SDK's `extractCode()` and `extractLink()`. Signup and login tests
 * usually want exactly these two things.
 *
 * Codes are only taken when a word like "code" or "verification" sits next
 * to them, so order numbers, prices, years and phone numbers stay out.
 * Links are ranked: action links (confirm, verify, reset, sign in) first,
 * in the order they appear; footers, unsubscribe and social links are
 * dropped.
 */

const CODE_WORD =
  /\b(?:code|codes|otp|passcode|pass code|pin|verification|verify|one[- ]time|security|confirmation|2fa|two[- ]factor|login|sign[- ]in|token)\b/i;
/** Digits (4 to 8, optionally split in two by a space or dash) or a mixed letters-and-digits token. */
const CODE_CANDIDATE =
  /(?<![\w#$€£@./:-])(\d{3,4}[ -]\d{3,4}|\d{4,8}|(?=[A-Z0-9]{0,7}\d)(?=[A-Z0-9]{0,7}[A-Z])[A-Z0-9]{6,8})(?![\w%@/:-]|[.,]\d)/g;
/** How far a code word may be from the code, in characters, within the same line. */
const CODE_WORD_REACH = 48;
const YEAR = /^(?:19|20)\d{2}$/;

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
/** The href in an anchor's attributes (the text between `<a` and `>`). */
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i;
const ACTION =
  /(confirm|verif|activat|reset|magic|log-?in|sign-?in|signin|login|invit|accept|approve|validat|onboard|set-?up|password|token|auth)/i;
const DROP =
  /(unsubscribe|opt-?out|preferences|manage[-_ ]?(?:email|notification|subscription)|privacy|terms|legal|help|support|\/track\/|\/open\/|\/pixel)/i;
const SOCIAL_HOSTS =
  /(^|\.)(facebook|twitter|x|linkedin|instagram|youtube|tiktok|github|discord|medium)\.com$/i;
const MAX_LINKS = 20;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

/** One pass, so "&amp;lt;" becomes "&lt;" and not "<". */
function decodeEntities(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|#39|apos|nbsp);/gi,
    (_, name: string) => ENTITIES[name.toLowerCase()]
  );
}

function isWordChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

/** `value` without leading and trailing characters outside [A-Za-z0-9_]. */
function trimNonWord(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && !isWordChar(value.charCodeAt(start))) start++;
  while (end > start && !isWordChar(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

const SKIPPED_ELEMENTS = /<(script|style|head)\b/gi;

/**
 * Drops `<script>`, `<style>` and `<head>` elements with their content. An
 * element without its closing tag is left for stripTags, as before; once a
 * name has no closing tag ahead, it is not searched for again.
 */
function dropSkippedElements(html: string): string {
  const lower = html.toLowerCase();
  const unclosed = new Set<string>();
  let out = "";
  let copied = 0;
  SKIPPED_ELEMENTS.lastIndex = 0;
  for (let match = SKIPPED_ELEMENTS.exec(html); match; match = SKIPPED_ELEMENTS.exec(html)) {
    const name = match[1].toLowerCase();
    if (unclosed.has(name)) continue;
    const close = lower.indexOf(`</${name}>`, match.index + match[0].length);
    if (close === -1) {
      unclosed.add(name);
      continue;
    }
    out += html.slice(copied, match.index) + " ";
    copied = close + name.length + 3;
    SKIPPED_ELEMENTS.lastIndex = copied;
  }
  return out + html.slice(copied);
}

/** Replaces every `<...>` tag with a space; a `<` without a later `>` stays as text. */
function stripTags(html: string): string {
  let out = "";
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) break;
    const close = html.indexOf(">", open + 1);
    if (close === -1) break;
    if (close === open + 1) {
      // "<>" is not a tag
      out += html.slice(index, close + 1);
    } else {
      out += html.slice(index, open) + " ";
    }
    index = close + 1;
  }
  return out + html.slice(index);
}

/** Each `<a href=...>label</a>`: the href and the raw HTML of its label. */
function findAnchors(html: string): { href: string; label: string }[] {
  const lower = html.toLowerCase();
  const anchors: { href: string; label: string }[] = [];
  let index = 0;
  let close = -1;
  while (index < html.length) {
    const open = lower.indexOf("<a", index);
    if (open === -1) break;
    if (open + 2 < lower.length && isWordChar(lower.charCodeAt(open + 2))) {
      index = open + 2;
      continue;
    }
    const tagEnd = lower.indexOf(">", open + 2);
    if (tagEnd === -1) break;
    if (close < tagEnd) close = lower.indexOf("</a>", tagEnd);
    if (close === -1) break;
    const href = HREF.exec(html.slice(open + 2, tagEnd));
    if (href) {
      anchors.push({
        href: href[1] ?? href[2] ?? href[3] ?? "",
        label: html.slice(tagEnd + 1, close),
      });
      index = close + 4;
    } else {
      index = tagEnd + 1;
    }
  }
  return anchors;
}

/** HTML to plain text, good enough for finding codes: tags out, block ends become line breaks. */
export function htmlToText(html: string): string {
  return decodeEntities(
    stripTags(
      dropSkippedElements(html)
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, "\n")
    )
  )
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function findCodes(sources: string[]): string[] {
  const found: string[] = [];
  const add = (raw: string) => {
    const value = raw.replace(/[ -]/g, "");
    if (!YEAR.test(value) && !found.includes(value)) found.push(value);
  };
  for (const source of sources) {
    const lines = source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    lines.forEach((line, index) => {
      // A code alone on its line, under a line that names it ("Your code is").
      const alone = trimNonWord(line);
      if (index > 0 && CODE_WORD.test(lines[index - 1])) {
        const match = [...alone.matchAll(CODE_CANDIDATE)];
        if (match.length === 1 && match[0][1] === alone) {
          add(alone);
          return;
        }
      }
      if (!CODE_WORD.test(line)) return;
      for (const match of line.matchAll(CODE_CANDIDATE)) {
        const raw = match[1];
        const start = match.index ?? 0;
        const before = line.slice(Math.max(0, start - CODE_WORD_REACH), start);
        const after = line.slice(start + raw.length, start + raw.length + CODE_WORD_REACH);
        if (CODE_WORD.test(before) || CODE_WORD.test(after)) add(raw);
      }
    });
  }
  return found;
}

const TRAILING_PUNCTUATION = ".,;:!?";

function cleanUrl(url: string): string | null {
  const decoded = decodeEntities(url.trim());
  let end = decoded.length;
  while (end > 0 && TRAILING_PUNCTUATION.includes(decoded[end - 1])) end--;
  const trimmed = decoded.slice(0, end);
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function keepLink(url: string, label: string | null): boolean {
  if (DROP.test(url) || (label !== null && DROP.test(label))) return false;
  try {
    return !SOCIAL_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function findLinks(text: string | null, html: string | null): ExtractedLink[] {
  const seen = new Set<string>();
  const links: ExtractedLink[] = [];
  const add = (rawUrl: string, label: string | null) => {
    const url = cleanUrl(rawUrl);
    if (!url || seen.has(url) || !keepLink(url, label)) return;
    seen.add(url);
    links.push({ url, label, action: ACTION.test(url) || (label !== null && ACTION.test(label)) });
  };
  if (html) {
    for (const anchor of findAnchors(html)) {
      const label = htmlToText(anchor.label).trim();
      add(anchor.href, label || null);
    }
  }
  for (const source of [text, html ? htmlToText(html) : null]) {
    if (!source) continue;
    for (const match of source.matchAll(URL_IN_TEXT)) add(match[0], null);
  }
  const ranked = [...links.filter((link) => link.action), ...links.filter((link) => !link.action)];
  return ranked.slice(0, MAX_LINKS);
}

/** The parts of an email the extractor reads. */
export type EmailContent = Pick<EmailCapture, "subject" | "text" | "html">;

/**
 * Finds the one-time codes and links in an email. Codes are only taken when
 * a word like "code" or "verification" is next to them; links are ranked
 * with action links (confirm, verify, reset, sign in) first.
 */
export function extractFromEmail(email: EmailContent): EmailExtracts {
  const text = email.text ?? (email.html ? htmlToText(email.html) : null);
  const sources = [email.subject ?? "", text ?? ""].filter(Boolean);
  return {
    codes: findCodes(sources),
    links: findLinks(email.text, email.html),
  };
}

/** An email, or a captured request that carries one. */
export type EmailLike = EmailContent | { email?: EmailContent | null };

function contentOf(input: EmailLike): EmailContent | null {
  if ("email" in input) return input.email ?? null;
  return input as EmailContent;
}

/**
 * The first one-time code in an email (or a captured email request), or
 * null when there is none.
 *
 * @example
 * ```ts
 * const email = await client.emails.waitFor(slug, { tag: runId });
 * const code = extractCode(email); // "482913"
 * ```
 */
export function extractCode(input: EmailLike): string | null {
  const content = contentOf(input);
  return content ? (extractFromEmail(content).codes[0] ?? null) : null;
}

/**
 * The link the email asks you to click (confirm, verify, reset, sign in)
 * when it has one, otherwise the first link worth keeping; null when there
 * is none. The same link the dashboard shows first. With `actionOnly: true`,
 * only an action link counts.
 */
export function extractLink(
  input: EmailLike,
  options: { actionOnly?: boolean } = {}
): string | null {
  const content = contentOf(input);
  if (!content) return null;
  // Links come ranked with action links first.
  const [best] = extractFromEmail(content).links;
  if (!best || (options.actionOnly && !best.action)) return null;
  return best.url;
}
