import { describe, expect, test } from "vitest";
import { signingCredentialProblem as mcpSigningCredentialProblem } from "@webhooks-cc/mcp/tools";

import {
  isValidSigningHeaderName,
  isValidSigningProvider,
  signingCredentialProblem,
} from "./signing-config";

describe("signing-config", () => {
  test("accepts compact HTTP header names used for Generic HMAC", () => {
    expect(isValidSigningHeaderName("x-signature")).toBe(true);
    expect(isValidSigningHeaderName("X_Custom_Signature_2")).toBe(true);
  });

  test("rejects missing, long, or unsafe header names", () => {
    expect(isValidSigningHeaderName("")).toBe(false);
    expect(isValidSigningHeaderName("x signature")).toBe(false);
    expect(isValidSigningHeaderName("x-signature:evil")).toBe(false);
    expect(isValidSigningHeaderName("x".repeat(257))).toBe(false);
    expect(isValidSigningHeaderName(null)).toBe(false);
  });

  test("accepts only providers with receiver verification support", () => {
    expect(isValidSigningProvider("stripe")).toBe(true);
    expect(isValidSigningProvider("discord")).toBe(true);
    expect(isValidSigningProvider("paypal")).toBe(true);
    expect(isValidSigningProvider("generic-hmac")).toBe(true);
    expect(isValidSigningProvider("sendgrid")).toBe(false);
    expect(isValidSigningProvider("plaid")).toBe(false);
    expect(isValidSigningProvider("unknown")).toBe(false);
    expect(isValidSigningProvider(null)).toBe(false);
  });

  test("refuses a Discord public key that is not 64 hex characters", () => {
    for (const key of [
      "abc",
      "g".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      ` ${"a".repeat(64)}`,
    ]) {
      expect(signingCredentialProblem("discord", key), key).toContain("64 hex characters");
    }
    expect(
      signingCredentialProblem("discord", "0123456789abcdefABCDEF".padEnd(64, "0"))
    ).toBeNull();
  });

  test("leaves other providers' credentials to the provider", () => {
    expect(signingCredentialProblem("stripe", "abc")).toBeNull();
    expect(signingCredentialProblem("generic-hmac", "secret")).toBeNull();
  });

  test("says the same as the MCP server's check", () => {
    for (const [provider, key] of [
      ["discord", "abc"],
      ["discord", "a".repeat(64)],
      ["stripe", "abc"],
    ]) {
      expect(signingCredentialProblem(provider, key), `${provider} ${key}`).toBe(
        mcpSigningCredentialProblem(provider, key)
      );
    }
  });
});
