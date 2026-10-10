/**
 * @fileoverview Proof-of-work solver for webhooks.cc anonymous agent
 * registration (scheme "sha256-zero-bits", see https://webhooks.cc/auth.md).
 *
 * For each sub-puzzle i in 0..count-1, find a decimal nonce such that
 * SHA-256 of the UTF-8 string `<challenge>.<i>.<nonce>` starts with
 * `difficulty` zero bits.
 *
 * Dependency-free and isomorphic. Per-call WebCrypto is far too slow for
 * millions of hashes, so this carries its own SHA-256: the challenge prefix
 * is compressed once per sub-puzzle and each attempt hashes only the final
 * block, which makes it several times faster than hashing the whole string
 * each time. The solver yields to the event loop about every 50 ms so a
 * browser tab stays responsive, and refuses more expected work than 2^26
 * hashes, so a hostile or broken server cannot pin the CPU.
 */

/** Expected work above this many hashes (2^26) is refused. */
export const MAX_POW_WORK_BITS = 26;

export interface PowChallenge {
  challenge: string;
  algorithm: string;
  difficulty: number;
  count: number;
  expires_at?: string;
}

export interface SolveOptions {
  /** Stops the solver; it rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Milliseconds of work between yields to the event loop (default 50). */
  yieldEveryMs?: number;
}

export class PowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PowError";
  }
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/** Compresses one 64-byte block (as 16 big-endian words in w[0..15]) into state. */
function compress(state: Uint32Array, w: Uint32Array): void {
  for (let t = 16; t < 64; t++) {
    const x = w[t - 15];
    const y = w[t - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
  }
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  let f = state[5];
  let g = state[6];
  let h = state[7];
  for (let t = 0; t < 64; t++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[t] + w[t]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
  state[4] = (state[4] + e) | 0;
  state[5] = (state[5] + f) | 0;
  state[6] = (state[6] + g) | 0;
  state[7] = (state[7] + h) | 0;
}

function loadBlock(bytes: Uint8Array, offset: number, w: Uint32Array): void {
  for (let i = 0; i < 16; i++) {
    const p = offset + i * 4;
    w[i] = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
  }
}

/** True when the 256-bit digest (as 8 words) starts with `bits` zero bits. */
function leadingZeros(state: Uint32Array, bits: number): boolean {
  let word = 0;
  while (bits >= 32) {
    if (state[word] !== 0) return false;
    word++;
    bits -= 32;
  }
  return bits === 0 || state[word] >>> (32 - bits) === 0;
}

const encoder = new TextEncoder();

/**
 * Finds the nonce for sub-puzzle `index`: the prefix `<challenge>.<index>.`
 * is compressed once, then each attempt writes its digits after the
 * leftover prefix bytes and hashes the last one or two blocks.
 */
function* solveOne(
  challenge: string,
  index: number,
  difficulty: number
): Generator<number, string> {
  const prefix = encoder.encode(`${challenge}.${index}.`);
  const fullBlocks = Math.floor(prefix.length / 64);
  const w = new Uint32Array(64);
  const mid = new Uint32Array(INITIAL_STATE);
  for (let b = 0; b < fullBlocks; b++) {
    loadBlock(prefix, b * 64, w);
    compress(mid, w);
  }
  const tail = prefix.subarray(fullBlocks * 64);
  // The leftover prefix bytes, up to 16 nonce digits, 0x80 and the 8-byte
  // length always fit in two blocks.
  const buffer = new Uint8Array(128);
  buffer.set(tail);
  const state = new Uint32Array(8);
  const digits = new Uint8Array(16);

  for (let nonce = 0; ; nonce++) {
    let n = nonce;
    let len = 0;
    do {
      digits[len++] = 48 + (n % 10);
      n = Math.floor(n / 10);
    } while (n > 0);
    let p = tail.length;
    for (let i = len - 1; i >= 0; i--) buffer[p++] = digits[i];
    buffer[p++] = 0x80;
    const blocks = p + 8 <= 64 ? 1 : 2;
    const end = blocks * 64;
    buffer.fill(0, p, end - 8);
    const bitLength = (prefix.length + len) * 8;
    // Messages here are far below 2^32 bits, so the high word stays 0.
    buffer[end - 8] = 0;
    buffer[end - 7] = 0;
    buffer[end - 6] = 0;
    buffer[end - 5] = 0;
    buffer[end - 4] = (bitLength >>> 24) & 0xff;
    buffer[end - 3] = (bitLength >>> 16) & 0xff;
    buffer[end - 2] = (bitLength >>> 8) & 0xff;
    buffer[end - 1] = bitLength & 0xff;

    state.set(mid);
    loadBlock(buffer, 0, w);
    compress(state, w);
    if (blocks === 2) {
      loadBlock(buffer, 64, w);
      compress(state, w);
    }
    if (leadingZeros(state, difficulty)) return String(nonce);
    if ((nonce & 0xfff) === 0xfff) yield nonce;
  }
}

/** SHA-256 hex digest of a UTF-8 string, with the solver's own implementation. */
export function sha256Hex(input: string): string {
  const bytes = encoder.encode(input);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bits = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(padded.length - 4, bits >>> 0);
  const state = new Uint32Array(INITIAL_STATE);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    loadBlock(padded, offset, w);
    compress(state, w);
  }
  return Array.from(state, (word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
}

/** Checks the challenge before spending CPU on it. */
export function assertSolvable(challenge: PowChallenge): void {
  if (challenge.algorithm !== "sha256-zero-bits") {
    throw new PowError(`Unsupported proof-of-work algorithm: ${challenge.algorithm}`);
  }
  const { difficulty, count } = challenge;
  if (
    !Number.isInteger(difficulty) ||
    !Number.isInteger(count) ||
    difficulty < 0 ||
    difficulty > 32 ||
    count < 1 ||
    count > 64
  ) {
    throw new PowError("Invalid proof-of-work parameters");
  }
  if (difficulty + Math.log2(count) > MAX_POW_WORK_BITS) {
    throw new PowError(
      `Refusing proof of work above 2^${MAX_POW_WORK_BITS} hashes (difficulty ${difficulty} x ${count})`
    );
  }
}

/**
 * Solves a challenge and returns one nonce per sub-puzzle. Yields to the
 * event loop about every `yieldEveryMs` milliseconds.
 */
export async function solveChallenge(
  challenge: PowChallenge,
  options: SolveOptions = {}
): Promise<string[]> {
  assertSolvable(challenge);
  const yieldEvery = options.yieldEveryMs ?? 50;
  const nonces: string[] = [];
  let sliceStart = Date.now();
  for (let i = 0; i < challenge.count; i++) {
    const search = solveOne(challenge.challenge, i, challenge.difficulty);
    for (;;) {
      const step = search.next();
      if (step.done) {
        nonces.push(step.value);
        break;
      }
      if (Date.now() - sliceStart >= yieldEvery) {
        options.signal?.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 0));
        sliceStart = Date.now();
      }
    }
    options.signal?.throwIfAborted();
  }
  return nonces;
}
