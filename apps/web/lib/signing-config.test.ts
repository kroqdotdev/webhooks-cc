import { describe, expect, test } from "vitest";

import { isValidSigningHeaderName, isValidSigningProvider } from "./signing-config";

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
});
