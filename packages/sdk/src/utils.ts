const DURATION_REGEX = /^(\d+)\s*(ms|s|m|h)$/;

/**
 * Parse a duration value into milliseconds.
 *
 * Accepts:
 * - Numbers: passed through as-is (treated as milliseconds)
 * - Numeric strings: `"500"` → 500
 * - Duration strings: `"30s"` → 30000, `"5m"` → 300000, `"1h"` → 3600000, `"500ms"` → 500
 *
 * @throws {Error} If the input string is not a valid duration format
 */
export function parseDuration(input: number | string): number {
  if (typeof input === "number") return input;

  const trimmed = input.trim();

  // Try plain numeric string first
  const asNumber = Number(trimmed);
  if (!isNaN(asNumber) && trimmed.length > 0) return asNumber;

  const match = DURATION_REGEX.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid duration: "${input}"`);
  }

  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      throw new Error(`Invalid duration: "${input}"`);
  }
}
