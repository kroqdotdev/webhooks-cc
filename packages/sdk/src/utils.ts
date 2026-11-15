const DURATION_REGEX = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;
/** Decimal digits with an optional fraction: not `Number()`, which also takes "0x10" and "1e3". */
const PLAIN_NUMBER_REGEX = /^\d+(?:\.\d+)?$/;

/**
 * Parse a duration value into milliseconds.
 *
 * Accepts:
 * - Numbers: passed through as-is (treated as milliseconds)
 * - Numeric strings: `"500"` → 500
 * - Duration strings: `"30s"` → 30000, `"5m"` → 300000, `"1.5s"` → 1500, `"500ms"` → 500, `"7d"` → 604800000
 *
 * @throws {Error} If the input string is not a valid duration format
 */
export function parseDuration(input: number | string): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`Invalid duration: must be a finite non-negative number, got ${input}`);
    }
    return input;
  }

  const trimmed = input.trim();

  // Try plain numeric string first
  if (PLAIN_NUMBER_REGEX.test(trimmed)) {
    return finiteDuration(Number(trimmed), input);
  }

  const match = DURATION_REGEX.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid duration: "${input}"`);
  }

  const value = parseFloat(match[1]);
  switch (match[2]) {
    case "ms":
      return finiteDuration(value, input);
    case "s":
      return finiteDuration(value * 1000, input);
    case "m":
      return finiteDuration(value * 60_000, input);
    case "h":
      return finiteDuration(value * 3_600_000, input);
    case "d":
      return finiteDuration(value * 86_400_000, input);
    default:
      throw new Error(`Invalid duration: "${input}"`);
  }
}

/**
 * `ms`, unless a digit string too long for a number (or a huge value times
 * its unit) made it Infinity: a wait with an infinite timeout would never end.
 */
function finiteDuration(ms: number, input: string): number {
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid duration: "${input}"`);
  }
  return ms;
}
