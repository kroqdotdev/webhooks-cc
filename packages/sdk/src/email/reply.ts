/**
 * The new text of an email reply: what the sender wrote above the quoted
 * message, without the signature. The same idea as GitHub's
 * email_reply_parser and the fields inbound mail APIs ship (Postmark's
 * StrippedTextReply, Mailgun's stripped-text, CloudMailin's reply_plain).
 *
 * It reads the text line by line, with short anchored patterns only, so it
 * takes time linear in the text whatever a sender writes. This module
 * imports nothing.
 */

export interface ParsedReply {
  /** The text above the quoted message, without the signature, trimmed. */
  text: string;
  /** Whether a quoted message (or a forwarded one) was found and cut. */
  quoted: boolean;
  /** The signature block that was cut, if one was found. */
  signature: string | null;
}

// "On Tue, 3 Mar 2026 at 10:02, Ada <ada@example.com> wrote:", and the same
// line in the languages mail clients write it in most: how it starts and
// how it ends. The header can wrap onto a second line, so it is checked on
// one line and on two joined. Plain string checks, no patterns.
const QUOTE_HEADERS: [start: string, end: string][] = [
  ["on ", " wrote:"],
  ["am ", ":"],
  ["le ", " a écrit :"],
  ["le ", " a écrit:"],
  ["le ", " a ecrit :"],
  ["el ", " escribió:"],
  ["el ", " escribio:"],
  ["op ", ":"],
  ["il ", " ha scritto:"],
  ["em ", " escreveu:"],
  ["den ", ":"],
];
// Words the ones that only end in ":" must hold, so "Am Ende:" is no header.
const QUOTE_HEADER_WORDS: Record<string, string> = {
  "am ": " schrieb ",
  "op ": " schreef ",
  "den ": " skrev ",
};
const MAX_QUOTE_HEADER_CHARS = 500;

// Separators clients put above a quoted or forwarded message.
const SEPARATORS = [
  /^-{2,}\s*Original Message\s*-{2,}$/i,
  /^-{2,}\s*Forwarded message\s*-{2,}$/i,
  /^Begin forwarded message:$/i,
  /^_{20,}$/,
];

// Outlook's quoted header block: From:, then Sent: or Date: within the next lines.
const OUTLOOK_FROM = /^\*?(From|Von|De|Van|Da|Fra):\*?\s/i;
const OUTLOOK_SENT =
  /^\*?(Sent|Date|Gesendet|Datum|Envoy[ée]|Enviado|Verzonden|Inviato|Sendt):\*?\s/i;

// "-- " is the standard delimiter; the rest are what mobile clients add.
const SIGNATURE_DELIMITER = /^--\s?$/;
const MOBILE_SIGNATURES = [
  /^Sent from my (iPhone|iPad|Android|BlackBerry|mobile|phone)\b.{0,100}$/i,
  /^Sent from (Mail|Outlook) for .{1,60}$/i,
  /^Get Outlook for (iOS|Android).{0,40}$/i,
  /^Sent from Yahoo Mail.{0,80}$/i,
];

/** Longest text read; mail text is kept up to 256 KB. */
const MAX_TEXT_CHARS = 300_000;

function isQuoteHeader(line: string): boolean {
  if (line.length > MAX_QUOTE_HEADER_CHARS) return false;
  const lower = line.toLowerCase();
  return QUOTE_HEADERS.some(([start, end]) => {
    if (!lower.startsWith(start) || !lower.endsWith(end)) return false;
    const word = QUOTE_HEADER_WORDS[start];
    return !word || lower.includes(word);
  });
}

/** The first "> " line of a run of them (and blank lines) that lasts to the end, or -1. */
function trailingQuoteStart(lines: string[]): number {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (!line.startsWith(">")) break;
    start = i;
  }
  return start;
}

/** Where the quoted message starts (a line index), or -1. */
function quoteStart(lines: string[]): number {
  const trailing = trailingQuoteStart(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (SEPARATORS.some((pattern) => pattern.test(line))) return i;
    if (isQuoteHeader(line)) return i;
    // A header wrapped onto two lines starts with a date ("On Sat, 24 Oct 2026
    // at 18:02, ..."); requiring a digit keeps a reply's own last line, such
    // as "On it.", from being read as half of one.
    const next = lines[i + 1]?.trim() ?? "";
    if (next && /\d/.test(line) && !/[.!?]$/.test(line) && isQuoteHeader(`${line} ${next}`)) {
      return i;
    }
    if (OUTLOOK_FROM.test(line)) {
      for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
        if (OUTLOOK_SENT.test(lines[j].trim())) return i;
      }
    }
    // A run of "> " lines that lasts to the end of the message.
    if (i === trailing) return i;
  }
  return -1;
}

/** Where the signature starts (a line index) among `lines`, or -1. */
function signatureStart(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SIGNATURE_DELIMITER.test(lines[i])) return i;
  }
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last--;
  if (last >= 0 && MOBILE_SIGNATURES.some((pattern) => pattern.test(lines[last].trim()))) {
    return last;
  }
  return -1;
}

function trimLines(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/^\s*\n/, "")
    .trimEnd();
}

/**
 * Splits an email's text into the new reply, the signature, and whether a
 * quoted (or forwarded) message followed. For a message that quotes
 * nothing, `text` is the whole text without its signature.
 */
export function parseReply(text: string | null | undefined): ParsedReply {
  if (!text) return { text: "", quoted: false, signature: null };
  const lines = text.slice(0, MAX_TEXT_CHARS).replace(/\r\n?/g, "\n").split("\n");
  const start = quoteStart(lines);
  const quoted = start >= 0;
  const above = quoted ? lines.slice(0, start) : lines;
  const cut = signatureStart(above);
  const body = cut >= 0 ? above.slice(0, cut) : above;
  const signature = cut >= 0 ? trimLines(above.slice(cut)) || null : null;
  return { text: trimLines(body), quoted, signature };
}

/**
 * The new text of a reply: what the sender wrote above the quoted message,
 * without the signature. Null when the email quotes no earlier message (it
 * is not a reply), or when nothing is written above the quote.
 */
export function replyText(text: string | null | undefined): string | null {
  const parsed = parseReply(text);
  return parsed.quoted && parsed.text ? parsed.text : null;
}
