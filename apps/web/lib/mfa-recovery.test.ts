import { describe, expect, it } from "vitest";
import {
  buildTwoFactorOffEmail,
  generateRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "./mfa-recovery";

describe("recovery codes", () => {
  it("are 10 unambiguous symbols in two groups", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRecoveryCode();
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
      expect(code).not.toMatch(/[01OIL]/);
    }
  });

  it("match however they are typed", () => {
    expect(normalizeRecoveryCode(" ab3de-fg4hk ")).toBe("AB3DEFG4HK");
    expect(hashRecoveryCode("ab3de fg4hk")).toBe(hashRecoveryCode("AB3DE-FG4HK"));
    expect(hashRecoveryCode("AB3DE-FG4HK")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("are not repeated", () => {
    const codes = new Set(Array.from({ length: 200 }, generateRecoveryCode));
    expect(codes.size).toBe(200);
  });

  it("tells the owner how two-factor went off", () => {
    const email = buildTwoFactorOffEmail({
      to: "jordan@acme.example",
      how: "recovery_code",
      appUrl: "https://webhooks.cc",
    });
    expect(email.text).toContain("recovery code");
    expect(email.text).toContain("https://webhooks.cc/account/security");
    expect(email.text).toContain("If this was not you");
  });
});
