/**
 * Webhook receiver base URL.
 * Must access directly (not via dynamic key) for Next.js bundler to inline the value.
 */
export const WEBHOOK_BASE_URL = (() => {
  const value = process.env.NEXT_PUBLIC_WEBHOOK_URL;
  if (!value) {
    throw new Error(
      `Required environment variable NEXT_PUBLIC_WEBHOOK_URL is not set. ` +
        `Please add it to your .env.local file.`
    );
  }
  return value;
})();

/** Constructs the full webhook URL for a given endpoint slug. */
export function getWebhookUrl(slug: string): string {
  return `${WEBHOOK_BASE_URL}/w/${slug}`;
}

/**
 * Headers to omit when generating curl commands.
 * - host: curl sets this based on the URL
 * - content-length: curl calculates this from the body
 * - connection: curl manages connection lifecycle
 */
export const SKIP_HEADERS_FOR_CURL: readonly string[] = ["host", "content-length", "connection"];
