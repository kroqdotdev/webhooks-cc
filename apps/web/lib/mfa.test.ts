import { describe, expect, it } from "vitest";
import { hasVerifiedFactor, jwtClaims, needsSecondFactor, sessionAal } from "./mfa";

function token(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode(claims)}.signature`;
}

describe("mfa", () => {
  it("reads the assurance level from the token", () => {
    expect(sessionAal(token({ aal: "aal2" }))).toBe("aal2");
    expect(sessionAal(token({ aal: "aal1" }))).toBe("aal1");
    expect(sessionAal(token({}))).toBe("aal1");
    expect(sessionAal("not-a-jwt")).toBe("aal1");
  });

  it("returns null claims for garbage", () => {
    expect(jwtClaims("a.%%%.c")).toBeNull();
  });

  it("counts only verified factors", () => {
    expect(hasVerifiedFactor({ factors: [{ status: "unverified" }] })).toBe(false);
    expect(hasVerifiedFactor({ factors: [{ status: "verified" }] })).toBe(true);
    expect(hasVerifiedFactor({})).toBe(false);
  });

  it("asks for the second factor only when one is set up and unused", () => {
    const verified = { factors: [{ status: "verified" }] };
    expect(needsSecondFactor(verified, token({ aal: "aal1" }))).toBe(true);
    expect(needsSecondFactor(verified, token({ aal: "aal2" }))).toBe(false);
    expect(needsSecondFactor({ factors: [] }, token({ aal: "aal1" }))).toBe(false);
  });
});
