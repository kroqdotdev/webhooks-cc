/**
 * Configuration from Convex environment variables.
 * Set via: npx convex env set KEY=value
 *
 * These defaults match the original hardcoded values.
 */

/**
 * Safely parses an integer from an environment variable with validation.
 * Throws an error if the value is invalid or out of range.
 */
function safeParseInt(envVar: string, defaultVal: number, min: number, max: number): number {
  const raw = process.env[envVar];
  if (!raw) return defaultVal;

  const value = parseInt(raw, 10);
  if (isNaN(value)) {
    console.error(`Invalid value for ${envVar}: "${raw}", using default ${defaultVal}`);
    return defaultVal;
  }
  if (value < min || value > max) {
    console.error(
      `Value for ${envVar} (${value}) out of range [${min}, ${max}], using default ${defaultVal}`
    );
    return defaultVal;
  }
  return value;
}

export const FREE_REQUEST_LIMIT = safeParseInt("FREE_REQUEST_LIMIT", 500, 1, 1000000);

export const PRO_REQUEST_LIMIT = safeParseInt("PRO_REQUEST_LIMIT", 500000, 1, 100000000);

export const EPHEMERAL_TTL_MS = safeParseInt("EPHEMERAL_TTL_MS", 600000, 60000, 86400000); // 1min to 24hrs

export const BILLING_PERIOD_MS = safeParseInt(
  "BILLING_PERIOD_MS",
  2592000000,
  86400000,
  31536000000
); // 1 day to 1 year
