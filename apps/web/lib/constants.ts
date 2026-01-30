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

export function getWebhookUrl(slug: string): string {
  return `${WEBHOOK_BASE_URL}/w/${slug}`;
}

export const SKIP_HEADERS_FOR_CURL: readonly string[] = ["host", "content-length", "connection"];
