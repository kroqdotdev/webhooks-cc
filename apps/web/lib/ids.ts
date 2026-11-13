import { randomBytes } from "node:crypto";
import { customAlphabet } from "nanoid";

/**
 * Every random identifier and token the app makes, in one place. Formats are
 * part of the stored data and of what clients accept (key prefixes, slug and
 * code checks), so each one stays exactly as it was.
 */

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const alphanumeric = customAlphabet(ALPHANUMERIC);

/** `length` random letters and digits ([A-Za-z0-9]): the body of a key, token or code. */
export function alphanumericToken(length: number): string {
  return alphanumeric(length);
}

/** An endpoint slug: 10 lowercase letters and digits. */
export const endpointSlug = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

/** One half of a code a person reads and types (device logins, approvals): 4 characters that cannot be misread (no I, L, O, 0, 1). */
export const userCodePart = customAlphabet("ABCDEFGHJKMNPQRSTUVWXYZ23456789", 4);

/** `bytes` random bytes as base64url: nonces, verifiers and share tokens. */
export function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}
