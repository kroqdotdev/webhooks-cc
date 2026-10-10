import { describe, expect, test } from "vitest";

// serverEnv() parses lazily; dummies for the fields it requires.
process.env.NEXT_PUBLIC_APP_URL = "https://webhooks.cc";
process.env.NEXT_PUBLIC_WEBHOOK_URL ??= "https://go.webhooks.cc";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.CAPTURE_SHARED_SECRET ??= "test-capture-secret";
process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.RECEIVER_INTERNAL_URL ??= "http://localhost:3001";

import {
  claimAttemptId,
  generateAttemptToken,
  generateUserCode,
  hashAttemptToken,
  hashUserCode,
  maskEmail,
  normalizeLoginHint,
  normalizeUserCode,
  verificationUri,
} from "./claims";

describe("claim secrets", () => {
  test("attempt tokens are cat_ plus 32 base62 characters", () => {
    const token = generateAttemptToken();
    expect(token).toMatch(/^cat_[A-Za-z0-9]{32}$/);
    expect(generateAttemptToken()).not.toBe(token);
    expect(verificationUri(token)).toBe(`https://webhooks.cc/agent/claim?attempt=${token}`);
    expect(claimAttemptId(hashAttemptToken(token))).toMatch(/^cla_[0-9a-f]{24}$/);
  });

  test("codes are 6 digits and bound to their attempt", () => {
    for (let i = 0; i < 50; i += 1) expect(generateUserCode()).toMatch(/^\d{6}$/);
    expect(hashUserCode("a", "123456")).not.toBe(hashUserCode("b", "123456"));
  });

  test("a typed code may carry spaces and dashes, nothing else", () => {
    expect(normalizeUserCode("123456")).toBe("123456");
    expect(normalizeUserCode(" 123-456 ")).toBe("123456");
    expect(normalizeUserCode("12345")).toBeNull();
    expect(normalizeUserCode("12345a")).toBeNull();
    expect(normalizeUserCode(123456)).toBeNull();
  });
});

describe("login hints", () => {
  test("are one lower-cased plain address", () => {
    expect(normalizeLoginHint(" Jane@Example.COM ")).toBe("jane@example.com");
    for (const bad of ["", "jane", "a@b@c.com", "x<a@example.com>", 5, undefined]) {
      expect(() => normalizeLoginHint(bad)).toThrow();
    }
  });

  test("refuse the capture domain", () => {
    expect(() => normalizeLoginHint("someone@mailhooks.cc")).toThrow();
  });

  test("are masked on the claim page", () => {
    expect(maskEmail("jane@example.com")).toBe("j***@example.com");
    expect(maskEmail("weird")).toBe("***");
  });
});
