import { VERIFY_PROVIDERS } from "@webhooks-cc/sdk";

export const SIGNING_HEADER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const MAX_SIGNING_HEADER_NAME_LENGTH = 256;
export const VALID_SIGNING_PROVIDERS = new Set<string>([...VERIFY_PROVIDERS, "generic-hmac"]);

export function isValidSigningHeaderName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SIGNING_HEADER_NAME_LENGTH &&
    SIGNING_HEADER_NAME_PATTERN.test(value)
  );
}

export function isValidSigningProvider(value: unknown): value is string {
  return typeof value === "string" && VALID_SIGNING_PROVIDERS.has(value);
}
