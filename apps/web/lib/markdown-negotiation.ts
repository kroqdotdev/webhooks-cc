/**
 * Markdown for agents: which requests get a page's markdown twin. The home
 * page's twin is app/index.md, the docs pages' twins are
 * app/docs.md/[[...slug]]. A twin is reached two ways:
 *
 * - its own URL: /index.md, /docs.md, and /docs/<slug>.md (next.config.ts
 *   rewrites the last, because a route segment cannot end in ".md");
 * - the page's URL with an Accept header that prefers text/markdown:
 *   proxy.ts decides with negotiatesMarkdown() and marks the request with
 *   MARKDOWN_TWIN_HEADER, and a next.config.ts rewrite that matches on that
 *   header serves the twin. A config rewrite stays inside the server, where
 *   a proxy.ts rewrite to an absolute URL is fetched over HTTP whenever its
 *   origin differs from the one the server listens on.
 *
 * proxy.ts runs this on every request, so the common case stays cheap: a
 * path check, and an Accept parse only when the header mentions markdown.
 * next.config.ts also sends a `rel="alternate"` Link to the twin from each
 * page that has one.
 */

/** Request header proxy.ts sets on requests to be answered with markdown. */
export const MARKDOWN_TWIN_HEADER = "x-markdown-twin";

export const MARKDOWN_RESPONSE_HEADERS = {
  "Content-Type": "text/markdown; charset=utf-8",
  "Cache-Control": "public, max-age=300",
} as const;

interface MediaRange {
  type: string;
  subtype: string;
  q: number;
}

function parseAccept(header: string): MediaRange[] {
  const ranges: MediaRange[] = [];
  for (const part of header.split(",")) {
    const [range, ...params] = part.split(";");
    const [type, subtype] = range.trim().toLowerCase().split("/");
    if (!type || !subtype) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split("=");
      if (key?.trim().toLowerCase() !== "q") continue;
      const parsed = Number(value?.trim());
      q = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
    }
    ranges.push({ type, subtype: subtype.trim(), q });
  }
  return ranges;
}

/**
 * The quality the client gives a media type: the most specific matching
 * range wins (RFC 9110 section 12.5.1), and with `wildcards` off only an
 * exact range counts. Null when nothing matches.
 */
function qualityOf(
  ranges: MediaRange[],
  type: string,
  subtype: string,
  wildcards: boolean
): number | null {
  let best: { specificity: number; q: number } | null = null;
  for (const range of ranges) {
    let specificity: number;
    if (range.type === type && range.subtype === subtype) specificity = 2;
    else if (wildcards && range.type === type && range.subtype === "*") specificity = 1;
    else if (wildcards && range.type === "*" && range.subtype === "*") specificity = 0;
    else continue;
    if (!best || specificity > best.specificity) best = { specificity, q: range.q };
  }
  return best?.q ?? null;
}

/**
 * True when the Accept header names text/markdown and rates it at least as
 * high as text/html. Only an explicit text/markdown counts, so browsers
 * (which send text/html and a wildcard) always get HTML. A tie goes to markdown:
 * a client that lists markdown at all is an agent that can read it.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept || !accept.toLowerCase().includes("text/markdown")) return false;
  const ranges = parseAccept(accept);
  const markdown = qualityOf(ranges, "text", "markdown", false);
  if (!markdown) return false;
  const html = qualityOf(ranges, "text", "html", true) ?? 0;
  return markdown >= html;
}

/** Whether a page has a markdown twin: the home page and every docs page. */
export function hasMarkdownTwin(pathname: string): boolean {
  if (pathname === "/" || pathname === "/docs") return true;
  return pathname.startsWith("/docs/") && !pathname.endsWith(".md");
}

/** Whether a request for a page should be answered by its markdown twin. */
export function negotiatesMarkdown(pathname: string, accept: string | null): boolean {
  return hasMarkdownTwin(pathname) && prefersMarkdown(accept);
}

/**
 * Whether a URL is a markdown twin's own address. Search engines get the
 * HTML page instead (X-Robots-Tag: noindex in proxy.ts), so the twins never
 * compete with it as duplicates.
 */
export function isMarkdownTwinPath(pathname: string): boolean {
  return (
    pathname === "/index.md" ||
    pathname === "/docs.md" ||
    pathname.startsWith("/docs.md/") ||
    (pathname.startsWith("/docs/") && pathname.endsWith(".md"))
  );
}
