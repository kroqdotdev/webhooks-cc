/** A string as one POSIX shell word: single quotes, with any inside it closed, escaped and reopened. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A curl command over several lines, one argument group per line. */
export function curlCommand(lines: readonly string[]): string {
  return ["curl -i -X POST", ...lines].join(" \\\n  ");
}
