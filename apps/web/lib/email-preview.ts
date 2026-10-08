/**
 * The document a captured email's HTML is shown in.
 *
 * It renders in an <iframe sandbox="allow-same-origin" srcdoc=...>: no
 * scripts can run (no allow-scripts), forms cannot submit, and nothing can
 * open or navigate another window. Same-origin is allowed only so the
 * dashboard can read the document's height; without allow-scripts the email
 * cannot use it. On top of the sandbox:
 *
 * - A Content-Security-Policy that allows inline styles and data: or cid:
 *   images and nothing else, so no remote styles, fonts, frames or
 *   (until the viewer asks) remote images load. Remote images tell the
 *   sender the email was opened, and from which IP.
 * - <base target="_blank">: link clicks would open a new window, which the
 *   sandbox forbids, so they do nothing.
 * - The email is disarmed first (see `sanitizeEmailHtml`): its own <meta>,
 *   <base> and <link> elements, its link targets, and inline SVG and MathML.
 *   The sandbox does not stop a frame navigating itself, which a meta
 *   refresh or a link with target="_self" would do.
 *
 * Email HTML is written for a white background, so the document is white in
 * dark mode too.
 */

/**
 * Start tags renamed to an unknown, inert element (<x-meta ...>):
 * - meta: a refresh navigates the frame, and the CSP does not stop it;
 * - base: would retarget the email's links;
 * - link: preconnect and dns-prefetch reach the network outside the CSP;
 * - svg, math: their links follow other rules than HTML's, and most mail
 *   clients do not render inline SVG or MathML anyway.
 */
const DISARMED_TAG = /<(meta|base|link|svg|math)\b/gi;
/**
 * Renames those start tags on the raw markup, before anything parses it.
 * Element names cannot be entity-encoded, so such an element can only come
 * from those literal letters, however its attributes are written
 * ("ref&#x72;esh" included). The inserted "x-" cannot join surrounding text
 * into a new match, so one pass is enough. With svg and math gone, the
 * markup has no foreign content, so parsing it here and again in the frame
 * builds the same tree.
 */
export function disarmTags(html: string): string {
  return html.replace(DISARMED_TAG, "<x-$1");
}

/**
 * The email's HTML as it goes into the preview frame: `disarmTags`, then the
 * browser's own parser (inert: scripting is off and nothing loads) drops
 * every target and formtarget attribute, so all links fall back to the
 * frame's <base target="_blank">, which the sandbox blocks. The email's head
 * and body are kept, body attributes included. Without a DOM parser (server
 * rendering) there is nothing safe to show, so the preview stays empty until
 * the browser builds it.
 */
export function sanitizeEmailHtml(html: string): string {
  if (typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(disarmTags(html), "text/html");
  for (const element of doc.querySelectorAll("[target], [formtarget]")) {
    element.removeAttribute("target");
    element.removeAttribute("formtarget");
  }
  return doc.head.innerHTML + doc.body.outerHTML;
}

const CHAR_REF =
  /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|colon|sol|period|lpar|rpar|tab|newline|nbsp));?/gi;
const NAMED_REFS: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  colon: ":",
  sol: "/",
  period: ".",
  lpar: "(",
  rpar: ")",
  tab: "\t",
  newline: "\n",
  nbsp: " ",
};
const IMAGE_ATTRIBUTE =
  /\b(src|srcset|poster|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const CSS_URL = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi;

/** Decodes the character references a URL could hide behind, for scanning only. */
function decodeCharRefs(html: string): string {
  return html.replace(CHAR_REF, (match, dec?: string, hex?: string, name?: string) => {
    if (dec || hex) {
      const codePoint = parseInt((dec ?? hex)!, dec ? 10 : 16);
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
    }
    return NAMED_REFS[name!.toLowerCase()] ?? match;
  });
}

/** What loading an image reference would take. */
function classify(value: string): "remote" | "inline" | "none" {
  // URL parsing drops tabs and newlines anywhere, and spaces around the URL.
  const url = Array.from(value)
    .filter((char) => char.charCodeAt(0) > 0x20)
    .join("")
    .toLowerCase();
  if (url === "" || url.startsWith("data:") || url.startsWith("#")) return "none";
  // A part of the message; its content is not kept, so it cannot be shown.
  if (url.startsWith("cid:")) return "inline";
  return "remote";
}

/**
 * The email's image references (src, srcset, poster and background
 * attributes, CSS url()): how many would load from outside the message, and
 * how many point at parts of the message itself (cid:). Anything not plainly
 * a data: URL, a cid: part or a #fragment counts as remote, so an obfuscated
 * URL still offers "Load images" rather than staying blocked for good;
 * counting too many only shows the button.
 */
export function countImageReferences(html: string): { remote: number; inline: number } {
  const decoded = decodeCharRefs(html);
  const counts = { remote: 0, inline: 0 };
  const add = (kinds: ("remote" | "inline" | "none")[]) => {
    if (kinds.includes("remote")) counts.remote++;
    else if (kinds.includes("inline")) counts.inline++;
  };
  for (const match of decoded.matchAll(IMAGE_ATTRIBUTE)) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    const urls = match[1].toLowerCase() === "srcset" ? value.split(/,\s+/) : [value];
    add(urls.map((url) => classify(url.trim().split(/\s+/)[0] ?? "")));
  }
  for (const match of decoded.matchAll(CSS_URL)) {
    add([classify(match[1] ?? match[2] ?? match[3] ?? "")]);
  }
  return counts;
}

/** How many image references would load from outside the message. */
export function countRemoteImages(html: string): number {
  return countImageReferences(html).remote;
}

export function previewPolicy(allowRemoteImages: boolean): string {
  const images = allowRemoteImages ? "data: cid: https: http:" : "data: cid:";
  return `default-src 'none'; style-src 'unsafe-inline'; img-src ${images}; font-src data:`;
}

export function buildPreviewDocument(
  html: string,
  options: { allowRemoteImages: boolean }
): string {
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${previewPolicy(options.allowRemoteImages)}">`,
    '<base target="_blank">',
    "<style>html,body{margin:0;background:#fff;color:#18181b}",
    "body{padding:16px;font:14px/1.5 Arial,Helvetica,sans-serif;overflow-wrap:anywhere}",
    "img{max-width:100%;height:auto}</style>",
    "</head><body>",
    sanitizeEmailHtml(html),
    "</body></html>",
  ].join("");
}
