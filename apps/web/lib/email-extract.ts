/**
 * Finds the one-time codes and links in a captured email, for the
 * dashboard's "Found in this email" strip. Signup and login tests usually
 * want exactly these two things.
 *
 * Codes are only taken when a word like "code" or "verification" sits next
 * to them, so order numbers, prices, years and phone numbers stay out.
 * Links are ranked: action links (confirm, verify, reset, sign in) first,
 * in the order they appear; footers, unsubscribe and social links are
 * dropped.
 */

export interface ExtractedLink {
  url: string;
  /** The link text, when the link came from HTML. */
  label: string | null;
  /** Looks like the thing the email asks you to click. */
  action: boolean;
}

export interface EmailExtracts {
  codes: string[];
  links: ExtractedLink[];
}

const CODE_WORD =
  /\b(?:code|codes|otp|passcode|pass code|pin|verification|verify|one[- ]time|security|confirmation|2fa|two[- ]factor|login|sign[- ]in|token)\b/i;
/** Digits (4 to 8, optionally split in two by a space or dash) or a mixed letters-and-digits token. */
const CODE_CANDIDATE =
  /(?<![\w#$€£@./:-])(\d{3,4}[ -]\d{3,4}|\d{4,8}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8})(?![\w%@/:-]|[.,]\d)/g;
/** How far a code word may be from the code, in characters, within the same line. */
const CODE_WORD_REACH = 48;
const YEAR = /^(?:19|20)\d{2}$/;

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const ANCHOR = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
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

/** HTML to plain text, good enough for finding codes: tags out, block ends become line breaks. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
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
      const alone = line.replace(/^[^\w]+|[^\w]+$/g, "");
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

function cleanUrl(url: string): string | null {
  const trimmed = decodeEntities(url.trim()).replace(/[.,;:!?]+$/, "");
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
    for (const match of html.matchAll(ANCHOR)) {
      const label = htmlToText(match[4] ?? "").trim();
      add(match[1] ?? match[2] ?? match[3] ?? "", label || null);
    }
  }
  for (const source of [text, html ? htmlToText(html) : null]) {
    if (!source) continue;
    for (const match of source.matchAll(URL_IN_TEXT)) add(match[0], null);
  }
  const ranked = [...links.filter((link) => link.action), ...links.filter((link) => !link.action)];
  return ranked.slice(0, MAX_LINKS);
}

export function extractFromEmail(email: {
  subject: string | null;
  text: string | null;
  html: string | null;
}): EmailExtracts {
  const text = email.text ?? (email.html ? htmlToText(email.html) : null);
  const sources = [email.subject ?? "", text ?? ""].filter(Boolean);
  return {
    codes: findCodes(sources),
    links: findLinks(email.text, email.html),
  };
}
