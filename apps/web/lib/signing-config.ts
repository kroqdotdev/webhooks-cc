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

/**
 * Why a signing credential cannot be the provider's, for the providers whose
 * credential has a fixed form; null when it may be. The MCP server checks
 * the same before create_endpoint creates anything
 * (signingCredentialProblem() in packages/mcp/src/tools.ts, which cannot
 * import web code): change both together.
 */
export function signingCredentialProblem(provider: string, secret: string): string | null {
  // Discord's application public key: an Ed25519 key of 32 bytes, in hex.
  if (provider === "discord" && !/^[0-9a-fA-F]{64}$/.test(secret)) {
    return "signingSecret for discord is the application's public key: 64 hex characters, from the Discord developer portal's General Information page.";
  }
  return null;
}

/**
 * The signing credential as the dashboard sends it: a Discord public key is
 * trimmed, since a pasted key often carries a space, the route accepts only
 * exactly 64 hex characters, and the receiver decodes the key exactly as
 * stored. Every other credential is a secret used byte for byte, so it is
 * sent exactly as typed.
 */
export function normalizeSigningCredential(provider: string, secret: string): string {
  return provider === "discord" ? secret.trim() : secret;
}
