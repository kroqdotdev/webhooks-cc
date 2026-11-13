import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability", () => ({ reportError: vi.fn() }));

import {
  decryptSigningSecret,
  encryptSigningSecret,
  openBytes,
  openJson,
  purposeKey,
  safeEqual,
  sealBytes,
  sealJson,
} from "./crypto";

const KEY = Buffer.alloc(32, 7);

/** The layout written by hand before the helpers existed, and read by the receiver's crypto.rs. */
function legacySeal(key: Buffer, plaintext: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

describe("sealBytes and openBytes", () => {
  it("open what the old hand-written layout sealed", () => {
    expect(openBytes(KEY, legacySeal(KEY, "whsec_abc")).toString("utf8")).toBe("whsec_abc");
  });

  it("seal as nonce, ciphertext, tag", () => {
    const sealed = sealBytes(KEY, "hello");
    expect(sealed.length).toBe(12 + 5 + 16);
    expect(openBytes(KEY, sealed).toString("utf8")).toBe("hello");
  });

  it("refuse a changed value, another key and a short value", () => {
    const sealed = sealBytes(KEY, "hello");
    sealed[14] ^= 1;
    expect(() => openBytes(KEY, sealed)).toThrow();
    expect(() => openBytes(Buffer.alloc(32, 8), sealBytes(KEY, "hello"))).toThrow();
    expect(() => openBytes(KEY, Buffer.alloc(28))).toThrow("Ciphertext too short");
  });
});

describe("sealJson and openJson", () => {
  it("round-trip a value as base64url", () => {
    const sealed = sealJson(KEY, { userId: "u1", expires: 5 });
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(openJson(KEY, sealed)).toEqual({ userId: "u1", expires: 5 });
  });

  it("open a value sealed the old way", () => {
    const sealed = legacySeal(KEY, JSON.stringify({ a: 1 })).toString("base64url");
    expect(openJson(KEY, sealed)).toEqual({ a: 1 });
  });

  it("are null for garbage, other keys and other purposes", () => {
    expect(openJson(KEY, "not sealed")).toBeNull();
    const grant = sealJson(purposeKey(KEY, "grant"), { a: 1 });
    expect(openJson(purposeKey(KEY, "ticket"), grant)).toBeNull();
    expect(openJson(purposeKey(KEY, "grant"), grant)).toEqual({ a: 1 });
  });
});

describe("safeEqual", () => {
  it("compares strings and buffers, unequal on any difference in length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual(Buffer.from("abc"), "abc")).toBe(true);
  });
});

describe("signing secrets", () => {
  const saved = process.env.SIGNING_SECRET_KEY;
  beforeEach(() => {
    process.env.SIGNING_SECRET_KEY = KEY.toString("base64");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SIGNING_SECRET_KEY;
    else process.env.SIGNING_SECRET_KEY = saved;
  });

  it("round-trip and read secrets stored before the helpers", () => {
    expect(decryptSigningSecret(encryptSigningSecret("whsec_1"))).toBe("whsec_1");
    expect(decryptSigningSecret(legacySeal(KEY, "whsec_2"))).toBe("whsec_2");
  });

  it("refuse to work without the key", () => {
    delete process.env.SIGNING_SECRET_KEY;
    expect(() => encryptSigningSecret("x")).toThrow("SIGNING_SECRET_KEY is not configured");
  });
});
