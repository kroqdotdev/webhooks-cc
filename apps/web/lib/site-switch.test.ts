import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSwitchCookie,
  consentCarryCookie,
  isNonceHash,
  newNonce,
  nonceHash,
  nonceMatches,
  openGrant,
  openTicket,
  sealGrant,
  sealTicket,
  switchCookie,
  switchKeyConfigured,
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
    userId: "00000000-0000-4000-8000-000000000001",
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

describe("site switch grants", () => {
  it("opens what it sealed until it expires", () => {
    const grant = { userId: "00000000-0000-4000-8000-000000000001", expires: Date.now() + 1000 };
    expect(openGrant(sealGrant(grant))).toEqual(grant);
    expect(openGrant(sealGrant({ ...grant, expires: Date.now() - 1 }))).toBeNull();
  });

  it("never passes for a ticket, nor a ticket for a grant", () => {
    const sealedTicket = sealTicket(ticket());
    expect(openGrant(sealedTicket)).toBeNull();
    const sealedGrant = sealGrant({ userId: "x", expires: Date.now() + 1000 });
    expect(openTicket(sealedGrant)).toBeNull();
  });
  it("carries the cookie banner answer, and only a real one", () => {
    const grant = { userId: "x", expires: Date.now() + 1000, consent: "granted" as const };
    expect(openGrant(sealGrant(grant))?.consent).toBe("granted");
    expect(openGrant(sealGrant({ ...grant, consent: "maybe" as unknown as "granted" }))).toBeNull();
    expect(openTicket(sealTicket(ticket({ consent: "denied" })))?.consent).toBe("denied");
  });
});

describe("carried consent cookie", () => {
  it("is a __Host- cookie over https that scripts can read", () => {
    const cookie = consentCarryCookie("granted", true);
    expect(cookie).toMatch(/^__Host-whk_consent_carry=granted; Path=\/;/);
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain("HttpOnly");
    expect(consentCarryCookie("denied", false)).toMatch(/^whk_consent_carry=denied; Path=\/;/);
  });
});

describe("site switch key", () => {
  it("needs a 32-byte base64 key", () => {
    expect(switchKeyConfigured()).toBe(true);
    vi.stubEnv("SIGNING_SECRET_KEY", "not a key");
    expect(switchKeyConfigured()).toBe(false);
    expect(() => sealTicket(ticket())).toThrow(/32-byte/);
    vi.stubEnv("SIGNING_SECRET_KEY", "");
    expect(switchKeyConfigured()).toBe(false);
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

  it("is a __Host- cookie over https, read only under that name there", () => {
    const nonce = newNonce();
    expect(switchCookie(nonce, true)).toBe(
      `__Host-whcc_site_switch=${nonce}; Path=/; Max-Age=300; HttpOnly; SameSite=Lax; Secure`
    );
    const secure = new Request("https://mailhooks.cc/auth/switch/finish", {
      headers: { cookie: `whcc_site_switch=planted; __Host-whcc_site_switch=${nonce}` },
    });
    expect(switchNonceOf(secure, true)).toBe(nonce);
    // A plain cookie a subdomain could set does not count over https.
    const planted = new Request("https://mailhooks.cc/auth/switch/finish", {
      headers: { cookie: "whcc_site_switch=planted" },
    });
    expect(switchNonceOf(planted, true)).toBeNull();
    expect(clearSwitchCookie(true)).toContain("__Host-whcc_site_switch=; Path=/; Max-Age=0");
  });

  it("is scoped to /auth/switch over plain http, for local development", () => {
    const nonce = newNonce();
    expect(switchCookie(nonce, false)).toMatch(/^whcc_site_switch=.+; Path=\/auth\/switch;/);
    const request = new Request("http://mailhooks.localhost:3210/auth/switch/finish", {
      headers: { cookie: `sb-x=1; whcc_site_switch=${nonce}; other=2` },
    });
    expect(switchNonceOf(request, false)).toBe(nonce);
    expect(switchNonceOf(new Request("http://mailhooks.localhost:3210/"), false)).toBeNull();
  });
});
