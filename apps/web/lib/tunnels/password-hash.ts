import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/*
 * Passwords on preview links, hashed with scrypt. Only the hash is kept:
 * "scrypt$<N>$<r>$<p>$<salt>$<hash>", salt and hash base64url.
 */

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAXMEM = 64 * 1024 * 1024;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/** What is wrong with a password for a link, if anything. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Keep it under ${PASSWORD_MAX} characters.`;
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return ["scrypt", N, R, P, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  if (password.length === 0 || password.length > PASSWORD_MAX) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every((x) => Number.isSafeInteger(x) && x > 0) || n > 1 << 20) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (expected.length !== KEY_LENGTH) return false;
  const given = await scrypt(password.normalize("NFKC"), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: MAXMEM,
  });
  return timingSafeEqual(given, expected);
}

/**
 * The version a run's own password gets: an HMAC of the account, the name and
 * the CLI's run id under the server's secret. A run cannot change its
 * password between reconnects (the CLI sends the same one each time), so the
 * run id is enough to keep the version, and so visitors stay let in, across
 * reconnects; a new run gets a new version and asks again. The password
 * itself never goes into it: only scrypt (hashPassword) ever sees a password.
 * Without a run id (never from a current CLI) the version is fresh.
 */
export function runPasswordVersion(
  secret: string,
  userId: string,
  name: string,
  instance: string | null
): string {
  if (!instance) return newPasswordVersion();
  return createHmac("sha256", secret)
    .update(`share-password|${userId}|${name}|${instance}`)
    .digest("hex")
    .slice(0, 32);
}

/** A fresh version for a name's password: every change asks visitors again. */
export function newPasswordVersion(): string {
  return randomBytes(16).toString("hex");
}
