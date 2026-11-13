/**
 * The value of the cookie `name` in a Cookie header (or `document.cookie`),
 * or null when it is missing or empty.
 */
export function cookieValue(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}
