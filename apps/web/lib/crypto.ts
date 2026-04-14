import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_SIZE = 12;
const TAG_SIZE = 16;

/**
 * Get the signing secret encryption key from environment.
 * Returns null if SIGNING_SECRET_KEY is not set (signing features disabled).
 */
function getKey(): Buffer | null {
  const b64 = process.env.SIGNING_SECRET_KEY;
  if (!b64) return null;
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) {
    console.warn(
      "SIGNING_SECRET_KEY is not 32 bytes after base64 decode — signing features disabled"
    );
    return null;
  }
  return buf;
}

/**
 * Encrypt a signing secret with AES-256-GCM.
 * Returns raw bytes: [12-byte nonce][ciphertext][16-byte tag].
 * Throws if SIGNING_SECRET_KEY is not configured.
 */
export function encryptSigningSecret(plaintext: string): Buffer {
  const key = getKey();
  if (!key) {
    throw new Error("SIGNING_SECRET_KEY is not configured — cannot encrypt signing secrets");
  }

  const nonce = randomBytes(NONCE_SIZE);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([nonce, encrypted, tag]);
}

/**
 * Decrypt an AES-256-GCM encrypted signing secret.
 * Input is raw bytes: [12-byte nonce][ciphertext][16-byte tag].
 */
export function decryptSigningSecret(ciphertext: Buffer): string {
  const key = getKey();
  if (!key) {
    throw new Error("SIGNING_SECRET_KEY is not configured — cannot decrypt signing secrets");
  }

  if (ciphertext.length < NONCE_SIZE + TAG_SIZE + 1) {
    throw new Error("Ciphertext too short");
  }

  const nonce = ciphertext.subarray(0, NONCE_SIZE);
  const tag = ciphertext.subarray(ciphertext.length - TAG_SIZE);
  const encrypted = ciphertext.subarray(NONCE_SIZE, ciphertext.length - TAG_SIZE);

  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/**
 * Check if the signing secret key is configured.
 */
export function isSigningKeyConfigured(): boolean {
  return getKey() !== null;
}
