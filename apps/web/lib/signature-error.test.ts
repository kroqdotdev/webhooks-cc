import { describe, expect, it } from "vitest";
import { redactSignatureError } from "./signature-error";

describe("redactSignatureError", () => {
  it("drops the computed signature from a stored mismatch", () => {
    const stored = JSON.stringify({
      code: "mismatch",
      expected: "a1b2c3",
      received: "ffff",
      header: "x-hub-signature-256",
      message: "Computed signature does not match the received signature",
    });
    const out = redactSignatureError(stored);
    expect(out).not.toContain("a1b2c3");
    expect(JSON.parse(out!)).toEqual({
      code: "mismatch",
      received: "ffff",
      header: "x-hub-signature-256",
      message: "Computed signature does not match the received signature",
    });
  });

  it("keeps errors without one unchanged", () => {
    const stored = JSON.stringify({ code: "missing_header", header: "stripe-signature" });
    expect(redactSignatureError(stored)).toBe(stored);
    expect(redactSignatureError("expected something, not JSON")).toBe(
      "expected something, not JSON"
    );
    expect(redactSignatureError(null)).toBeNull();
    expect(redactSignatureError(undefined)).toBeNull();
  });
});
