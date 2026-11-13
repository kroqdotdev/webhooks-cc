import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { reportError } from "@/lib/observability";

const ALGORITHM = "aes-256-gcm";
const NONCE_SIZE = 12;
const TAG_SIZE = 16;

/**
 * AES-256-GCM with the layout every sealed value here uses, and the
 * receiver's `crypto.rs` reads: [12-byte nonce][ciphertext][16-byte tag].
 */
export function sealBytes(key: Buffer, plaintext: string | Buffer): Buffer {
  const nonce = randomBytes(NONCE_SIZE);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]);
}

/** The plaintext of `sealBytes`; throws when the value is short, changed or sealed under another key. */
export function openBytes(key: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < NONCE_SIZE + TAG_SIZE + 1) {
    throw new Error("Ciphertext too short");
  }
  const decipher = createDecipheriv(ALGORITHM, key, sealed.subarray(0, NONCE_SIZE));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_SIZE));
  return Buffer.concat([
    decipher.update(sealed.subarray(NONCE_SIZE, sealed.length - TAG_SIZE)),
    decipher.final(),
  ]);
}

/** A JSON value sealed for a URL or a cookie (base64url). */
export function sealJson(key: Buffer, value: unknown): string {
  return sealBytes(key, JSON.stringify(value)).toString("base64url");
}

/** The value `sealJson` sealed, or null when it is not one, has been changed or is under another key. */
export function openJson(key: Buffer, sealed: string): unknown {
  try {
    return JSON.parse(openBytes(key, Buffer.from(sealed, "base64url")).toString("utf8"));
  } catch {
    return null;
  }
}

/** A key of its own for one purpose, so a value sealed for one never opens as another. */
export function purposeKey(base: Buffer, purpose: string): Buffer {
  return createHash("sha256").update(base).update(purpose).digest();
}

/** Constant-time equality; values of different lengths are simply unequal. */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const left = typeof a === "string" ? Buffer.from(a, "utf8") : a;
  const right = typeof b === "string" ? Buffer.from(b, "utf8") : b;
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Get the signing secret encryption key from environment.
 * Returns null if SIGNING_SECRET_KEY is not set (signing features disabled).
 */
function getKey(): Buffer | null {
  const b64 = process.env.SIGNING_SECRET_KEY;
  if (!b64) return null;
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) {
    reportError("SIGNING_SECRET_KEY is not 32 bytes after base64 decode; signing features are off");
    return null;
  }
  return buf;
}

/**
 * Encrypt a signing secret with AES-256-GCM (`sealBytes`).
 * Throws if SIGNING_SECRET_KEY is not configured.
 */
export function encryptSigningSecret(plaintext: string): Buffer {
  const key = getKey();
  if (!key) {
    throw new Error("SIGNING_SECRET_KEY is not configured, so signing secrets cannot be encrypted");
  }
  return sealBytes(key, plaintext);
}

/** Decrypt a signing secret sealed by `encryptSigningSecret`. */
export function decryptSigningSecret(ciphertext: Buffer): string {
  const key = getKey();
  if (!key) {
    throw new Error("SIGNING_SECRET_KEY is not configured, so signing secrets cannot be decrypted");
  }
  return openBytes(key, ciphertext).toString("utf8");
}

/**
 * Check if the signing secret key is configured.
 */
export function isSigningKeyConfigured(): boolean {
  return getKey() !== null;
}
