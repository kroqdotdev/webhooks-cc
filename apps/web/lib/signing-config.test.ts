import { describe, expect, test } from "vitest";
import {
  SIGNING_PROVIDERS,
  signingCredentialProblem as mcpSigningCredentialProblem,
} from "@webhooks-cc/mcp/tools";

import {
  isValidSigningHeaderName,
  isValidSigningProvider,
  normalizeSigningCredential,
  signingCredentialProblem,
  VALID_SIGNING_PROVIDERS,
} from "./signing-config";

/** A well-formed Discord public key, in mixed case. */
const DISCORD_KEY = "0123456789abcdefABCDEF0123456789abcdef0123456789abcdef0123456789";

const REFUSED_DISCORD_KEYS = [
  "abc",
  "g".repeat(64),
  "a".repeat(63),
  "a".repeat(65),
  ` ${"a".repeat(64)}`,
  `${"a".repeat(64)}\n`,
];

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
    for (const key of REFUSED_DISCORD_KEYS) {
      expect(signingCredentialProblem("discord", key), JSON.stringify(key)).toContain(
        "64 hex characters"
      );
    }
    expect(signingCredentialProblem("discord", DISCORD_KEY)).toBeNull();
  });

  test("leaves other providers' credentials to the provider", () => {
    expect(signingCredentialProblem("stripe", "abc")).toBeNull();
    expect(signingCredentialProblem("generic-hmac", "secret")).toBeNull();
  });

  test("trims only a Discord public key", () => {
    expect(normalizeSigningCredential("discord", ` ${DISCORD_KEY} `)).toBe(DISCORD_KEY);
    expect(normalizeSigningCredential("discord", "   ")).toBe("");
    expect(normalizeSigningCredential("generic-hmac", " s3cret ")).toBe(" s3cret ");
    expect(normalizeSigningCredential("stripe", " whsec_test ")).toBe(" whsec_test ");
  });

  test("says the same as the MCP server's check", () => {
    const cases: [string, string][] = [
      ...[...REFUSED_DISCORD_KEYS, DISCORD_KEY].map((key): [string, string] => ["discord", key]),
      ["stripe", "abc"],
    ];
    for (const [provider, key] of cases) {
      expect(signingCredentialProblem(provider, key), `${provider} ${JSON.stringify(key)}`).toBe(
        mcpSigningCredentialProblem(provider, key)
      );
    }
  });
});

describe("the MCP server's signing providers", () => {
  test("are the ones the API accepts", () => {
    expect([...SIGNING_PROVIDERS].sort()).toEqual([...VALID_SIGNING_PROVIDERS].sort());
  });
});
