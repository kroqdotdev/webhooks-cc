declare const PKG_VERSION: string | undefined;

const SDK_VERSION = typeof PKG_VERSION !== "undefined" ? PKG_VERSION : "0.0.0-dev";

/**
 * The User-Agent for calls to the webhooks.cc API: the caller's own product
 * token first, if any, then the SDK's. Browsers keep their own (setting one
 * would only add a header to the CORS preflight), so none is sent there.
 * Throws on anything but printable ASCII in the product token: fetch refuses
 * control characters and anything above U+00FF in a header on every request.
 * @internal
 */
export function apiUserAgent(product: string | undefined): string | undefined {
  const extra = product?.trim();
  if (extra && /[^\x20-\x7e]/.test(extra)) {
    throw new Error("Invalid userAgent: use printable ASCII only, like my-tool/1.2.");
  }
  const userAgent = globalThis.navigator?.userAgent;
  if (typeof userAgent === "string" && userAgent.startsWith("Mozilla/")) return undefined;
  const own = `webhooks-cc-sdk/${SDK_VERSION}`;
  return extra ? `${extra} ${own}` : own;
}
