import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSwitchCookie,
  isNonceHash,
  newNonce,
  nonceHash,
  nonceMatches,
  openTicket,
  sealTicket,
  switchCookie,
  switchNonceOf,
  type SwitchTicket,
} from "./site-switch";

beforeEach(() => {
  vi.stubEnv("SIGNING_SECRET_KEY", randomBytes(32).toString("base64"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function ticket(overrides: Partial<SwitchTicket> = {}): SwitchTicket {
  return {
    tokenHash: "a".repeat(56),
    nonce: nonceHash(newNonce()),
    to: "mailhooks",
    next: "/dashboard?endpoint=acme",
    expires: Date.now() + 60_000,
    ...overrides,
  };
}

describe("site switch tickets", () => {
  it("opens what it sealed", () => {
    const original = ticket();
    expect(openTicket(sealTicket(original))).toEqual(original);
  });

  it("refuses an expired ticket", () => {
    const sealed = sealTicket(ticket({ expires: Date.now() - 1 }));
    expect(openTicket(sealed)).toBeNull();
  });

  it("refuses a changed ticket and one sealed under another key", () => {
    const sealed = sealTicket(ticket());
    const bytes = Buffer.from(sealed, "base64url");
    bytes[20] ^= 1;
    expect(openTicket(bytes.toString("base64url"))).toBeNull();

    vi.stubEnv("SIGNING_SECRET_KEY", randomBytes(32).toString("base64"));
    expect(openTicket(sealed)).toBeNull();
    expect(openTicket("")).toBeNull();
    expect(openTicket("not a ticket")).toBeNull();
  });

  it("refuses a ticket for a site that does not exist", () => {
    const sealed = sealTicket(ticket({ to: "elsewhere" as SwitchTicket["to"] }));
    expect(openTicket(sealed)).toBeNull();
  });
});

describe("site switch nonce", () => {
  it("matches only the browser's own nonce", () => {
    const mine = newNonce();
    const expected = nonceHash(mine);
    expect(isNonceHash(expected)).toBe(true);
    expect(nonceMatches(mine, expected)).toBe(true);
    expect(nonceMatches(newNonce(), expected)).toBe(false);
    expect(nonceMatches(null, expected)).toBe(false);
    expect(nonceMatches(mine, "short")).toBe(false);
    expect(isNonceHash("../../etc")).toBe(false);
  });

  it("reads its cookie among others and scopes it to /auth/switch", () => {
    const nonce = newNonce();
    const request = new Request("https://mailhooks.cc/auth/switch/finish", {
      headers: { cookie: `sb-x=1; whcc_site_switch=${nonce}; other=2` },
    });
    expect(switchNonceOf(request)).toBe(nonce);
    expect(switchNonceOf(new Request("https://mailhooks.cc/"))).toBeNull();
    expect(switchCookie(nonce, true)).toMatch(
      /Path=\/auth\/switch; .*HttpOnly; SameSite=Lax; Secure$/
    );
    expect(clearSwitchCookie(false)).toContain("Max-Age=0");
  });
});
