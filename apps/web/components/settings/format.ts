/** "Oct 14, 2026": dates in tables and lists. */
export function shortDate(value: string | number): string {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "October 14, 2026": dates in sentences, such as when a period renews. */
export function longDate(value: string | number): string {
  return new Date(value).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
