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
 * - The email's own <meta>, <base> and <link> elements are disarmed: a meta
 *   refresh navigates the frame (the CSP and the sandbox do not stop that),
 *   a base would retarget links, and link preconnect or dns-prefetch reach
 *   the network outside the CSP. See `disarmTags`.
 *
 * Email HTML is written for a white background, so the document is white in
 * dark mode too.
 */

const DISARMED_TAG = /<(meta|base|link)\b/gi;
const REMOTE_IMAGE =
  /<img\b[^>]*?\bsrc(?:set)?\s*=\s*["']?\s*(?:https?:)?\/\/|\bbackground\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//gi;

/** How many remote images (img, background attributes, CSS url()) the email would load. */
export function countRemoteImages(html: string): number {
  return html.match(REMOTE_IMAGE)?.length ?? 0;
}

export function previewPolicy(allowRemoteImages: boolean): string {
  const images = allowRemoteImages ? "data: cid: https: http:" : "data: cid:";
  return `default-src 'none'; style-src 'unsafe-inline'; img-src ${images}; font-src data:`;
}

/**
 * Renames every <meta, <base and <link start tag to an unknown, inert
 * element (<x-meta ...>). It works on the raw markup without parsing it: an
 * HTML element with one of those names can only come from that literal start
 * tag, however its attributes are written (entity-encoded "ref&#x72;esh"
 * included), and the inserted "x-" cannot join surrounding text into a new
 * match, so one pass is enough.
 */
export function disarmTags(html: string): string {
  return html.replace(DISARMED_TAG, "<x-$1");
}

export function buildPreviewDocument(
  html: string,
  options: { allowRemoteImages: boolean }
): string {
  const cleaned = disarmTags(html);
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${previewPolicy(options.allowRemoteImages)}">`,
    '<base target="_blank">',
    "<style>html,body{margin:0;background:#fff;color:#18181b}",
    "body{padding:16px;font:14px/1.5 Arial,Helvetica,sans-serif;overflow-wrap:anywhere}",
    "img{max-width:100%;height:auto}</style>",
    "</head><body>",
    cleaned,
    "</body></html>",
  ].join("");
}
