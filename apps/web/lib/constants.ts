/**
 * Validates that a required environment variable is set.
 * Throws an error if missing to ensure proper configuration.
 */
function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Required environment variable ${key} is not set. ` + `Please add it to your .env.local file.`
    );
  }
  return value;
}

export const WEBHOOK_BASE_URL = getRequiredEnv("NEXT_PUBLIC_WEBHOOK_URL");

export function getWebhookUrl(slug: string): string {
  return `${WEBHOOK_BASE_URL}/w/${slug}`;
}

export const SKIP_HEADERS_FOR_CURL: readonly string[] = ["host", "content-length", "connection"];
