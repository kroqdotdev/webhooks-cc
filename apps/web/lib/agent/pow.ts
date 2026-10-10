import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { POW_ALGORITHM, POW_CHALLENGE_TTL_SECONDS, POW_MAX_WORK_BITS } from "./constants";

/**
 * Proof of work for anonymous agent registration (our extension to
 * auth.md, scheme "sha256-zero-bits").
 *
 * A challenge is `pow1.<payload>.<mac>`: base64url JSON `{ v, id, iat, exp,
 * d, n, aud }` and base64url HMAC-SHA256 over everything before the last
 * dot. Difficulty, count, lifetime and audience sit inside the MAC, so a
 * client can neither lower the work nor carry a challenge to another
 * deployment. Verification is stateless; the registration insert stores the
 * challenge id in a unique column, which makes each challenge single use.
 *
 * The solution is one decimal nonce per sub-puzzle i in 0..n-1 such that
 * SHA-256 of the UTF-8 string `<challenge>.<i>.<nonce>` starts with d zero
 * bits. Many small puzzles instead of one large one keep the solve time
 * predictable.
 */

const PREFIX = "pow1";
const MAX_CHALLENGE_LENGTH = 512;
const MAX_NONCE_DIGITS = 16;
/** How far in the future an issue time may lie (clock skew between instances). */
const MAX_IAT_SKEW_SECONDS = 60;

export interface PowChallenge {
  challenge: string;
  algorithm: typeof POW_ALGORITHM;
  difficulty: number;
  count: number;
  expires_at: string;
}

interface PowPayload {
  v: 1;
  id: string;
  iat: number;
  exp: number;
  d: number;
  n: number;
  aud: string;
}

export type PowFailure =
  | "malformed"
  | "bad_mac"
  | "expired"
  | "wrong_audience"
  | "wrong_count"
  | "bad_nonce"
  | "insufficient_work";

export type PowVerification =
  { ok: true; id: string; difficulty: number; count: number } | { ok: false; reason: PowFailure };

function mac(secret: string, signed: string): Buffer {
  return createHmac("sha256", secret).update(signed).digest();
}

/** True when the digest starts with at least `bits` zero bits. */
export function hasLeadingZeroBits(digest: Buffer, bits: number): boolean {
  const fullBytes = bits >> 3;
  for (let i = 0; i < fullBytes; i += 1) {
    if (digest[i] !== 0) return false;
  }
  const rest = bits & 7;
  return rest === 0 || digest[fullBytes] >> (8 - rest) === 0;
}

/**
 * Difficulty for the next challenge: one more bit when the sandbox pool is
 * half full, two at 80 percent, and never more expected work than clients
 * accept (2^POW_MAX_WORK_BITS hashes in all).
 */
export function adaptiveDifficulty(
  base: number,
  count: number,
  poolUsed: number,
  poolSize: number
): number {
  const fill = poolSize > 0 ? poolUsed / poolSize : 1;
  const bump = fill >= 0.8 ? 2 : fill >= 0.5 ? 1 : 0;
  const ceiling = POW_MAX_WORK_BITS - Math.ceil(Math.log2(count));
  return Math.max(0, Math.min(base + bump, ceiling));
}

export function issueChallenge(input: {
  secret: string;
  audience: string;
  difficulty: number;
  count: number;
  now?: number;
}): PowChallenge {
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const payload: PowPayload = {
    v: 1,
    id: randomBytes(16).toString("base64url"),
    iat,
    exp: iat + POW_CHALLENGE_TTL_SECONDS,
    d: input.difficulty,
    n: input.count,
    aud: input.audience,
  };
  const signed = `${PREFIX}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return {
    challenge: `${signed}.${mac(input.secret, signed).toString("base64url")}`,
    algorithm: POW_ALGORITHM,
    difficulty: payload.d,
    count: payload.n,
    expires_at: new Date(payload.exp * 1000).toISOString(),
  };
}

function parsePayload(encoded: string): PowPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
  if (
    p.v !== 1 ||
    typeof p.id !== "string" ||
    p.id.length < 1 ||
    p.id.length > 64 ||
    !isInt(p.iat) ||
    !isInt(p.exp) ||
    !isInt(p.d) ||
    p.d < 0 ||
    p.d > 32 ||
    !isInt(p.n) ||
    p.n < 1 ||
    p.n > 64 ||
    typeof p.aud !== "string"
  ) {
    return null;
  }
  return p as unknown as PowPayload;
}

/**
 * Checks a submitted solution. `secrets` lists the current secret first and
 * the previous one (during a rotation) after it.
 */
export function verifySolution(input: {
  challenge: unknown;
  nonces: unknown;
  secrets: string[];
  audience: string;
  now?: number;
}): PowVerification {
  const { challenge, nonces } = input;
  if (typeof challenge !== "string" || challenge.length > MAX_CHALLENGE_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const parts = challenge.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    return { ok: false, reason: "malformed" };
  }

  const signed = `${parts[0]}.${parts[1]}`;
  const given = Buffer.from(parts[2], "base64url");
  const macMatches = input.secrets.some((secret) => {
    const expected = mac(secret, signed);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!macMatches) return { ok: false, reason: "bad_mac" };

  const payload = parsePayload(parts[1]);
  if (!payload) return { ok: false, reason: "malformed" };

  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (payload.exp <= now || payload.iat > now + MAX_IAT_SKEW_SECONDS) {
    return { ok: false, reason: "expired" };
  }
  if (payload.aud !== input.audience) return { ok: false, reason: "wrong_audience" };

  if (!Array.isArray(nonces) || nonces.length !== payload.n) {
    return { ok: false, reason: "wrong_count" };
  }
  for (let i = 0; i < nonces.length; i += 1) {
    const nonce = nonces[i];
    if (typeof nonce !== "string" || !/^[0-9]+$/.test(nonce) || nonce.length > MAX_NONCE_DIGITS) {
      return { ok: false, reason: "bad_nonce" };
    }
    const digest = createHash("sha256").update(`${challenge}.${i}.${nonce}`).digest();
    if (!hasLeadingZeroBits(digest, payload.d)) {
      return { ok: false, reason: "insufficient_work" };
    }
  }

  return { ok: true, id: payload.id, difficulty: payload.d, count: payload.n };
}

/**
 * Straightforward solver (one createHash per attempt). The SDK ships the
 * fast one; this one serves tests and scripts.
 */
export function solveChallenge(challenge: string, difficulty: number, count: number): string[] {
  const nonces: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let nonce = 0;
    while (
      !hasLeadingZeroBits(
        createHash("sha256").update(`${challenge}.${i}.${nonce}`).digest(),
        difficulty
      )
    ) {
      nonce += 1;
    }
    nonces.push(String(nonce));
  }
  return nonces;
}
