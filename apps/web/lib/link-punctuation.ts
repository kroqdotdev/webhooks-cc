/**
 * A link written in a sentence ("create one at
 * https://webhooks.cc/account/api-keys.") or in parentheses is often opened
 * with the punctuation after it: terminals, package registries, editors and
 * chat answers take it as part of the URL, and the visitor lands on a 404.
 * No page of ours ends in these characters, so the proxy sends such a path
 * to the page without them.
 *
 * Covers sentence punctuation, closing brackets and quotes, and the
 * percent-encoded forms a browser sends for `"`, `'`, `)`, `>`, `]` and the
 * backtick (as in `<https://...>` or a Markdown code span).
 */
const TRAILING_PUNCTUATION = /(?:[.,;:!)\]'*]|%22|%27|%29|%3E|%5D|%60)+$/i;

/** The path without trailing punctuation, or null when it has none. */
export function withoutTrailingPunctuation(pathname: string): string | null {
  const trimmed = pathname.replace(TRAILING_PUNCTUATION, "");
  if (trimmed === pathname) return null;
  return trimmed === "" ? "/" : trimmed;
}
