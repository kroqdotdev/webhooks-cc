/**
 * Configuration from Convex environment variables.
 * Set via: npx convex env set KEY value
 *
 * IMPORTANT: Values are evaluated at module load time (deployment).
 * After changing an env var, you must redeploy for it to take effect:
 *   npx convex dev --once   (dev)
 *   npx convex deploy       (prod)
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

export const FREE_REQUEST_LIMIT = safeParseInt("FREE_REQUEST_LIMIT", 200, 1, 1000000);

export const PRO_REQUEST_LIMIT = safeParseInt("PRO_REQUEST_LIMIT", 500000, 1, 100000000);

// Guest demo endpoints: 10-hour lifetime by default.
// Keeping this below the free tier (200 requests/day) nudges signups without blocking evaluation.
export const EPHEMERAL_TTL_MS = safeParseInt(
  "EPHEMERAL_TTL_MS",
  10 * 60 * 60 * 1000,
  60000,
  86400000
); // 1min to 24hrs

export const BILLING_PERIOD_MS = safeParseInt(
  "BILLING_PERIOD_MS",
  2592000000,
  86400000,
  31536000000
); // 1 day to 1 year

// Free user rolling period (24 hours in milliseconds)
export const FREE_PERIOD_MS = 24 * 60 * 60 * 1000;

// Pro user request retention (30 days in milliseconds)
export const PRO_REQUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Abuse protection: maximum active ephemeral endpoints before rejecting new ones
export const MAX_EPHEMERAL_ENDPOINTS = safeParseInt("MAX_EPHEMERAL_ENDPOINTS", 500, 10, 10000);

// Polar.sh Configuration
export const POLAR_SANDBOX = process.env.POLAR_SANDBOX === "true";
export const POLAR_API_URL = POLAR_SANDBOX
  ? "https://sandbox-api.polar.sh"
  : "https://api.polar.sh";
export const POLAR_ORGANIZATION_ID = process.env.POLAR_ORGANIZATION_ID ?? "";
