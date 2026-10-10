import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertSolvable, PowError, sha256Hex, solveChallenge } from "../pow";

// The server's fixture (apps/web/lib/agent/pow.test.ts reads the same file):
// both must agree on the nonces, which are the smallest that work.
const fixture = JSON.parse(
  readFileSync(new URL("../../../../apps/web/lib/agent/pow-vectors.json", import.meta.url), "utf8")
) as {
  vectors: { challenge: string; difficulty: number; count: number; nonces: string[] }[];
};

describe("sha256Hex", () => {
  it("matches node:crypto across block boundaries", () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 200, 1000]) {
      const input = "x".repeat(length) + "é".repeat(length % 3);
      expect(sha256Hex(input)).toBe(createHash("sha256").update(input).digest("hex"));
    }
  });
});

describe("solveChallenge", () => {
  it.each(fixture.vectors)("finds the server's nonces at difficulty $difficulty x $count", async (vector) => {
    const nonces = await solveChallenge({ ...vector, algorithm: "sha256-zero-bits" });
    expect(nonces).toEqual(vector.nonces);
  });

  it("produces hashes with the leading zero bits, for long challenges too", async () => {
    // A prefix that ends close to a block boundary exercises the two-block tail.
    for (const length of [40, 50, 55, 60, 63, 64, 200]) {
      const challenge = `pow1.${"a".repeat(length)}.sig`;
      const nonces = await solveChallenge({
        challenge,
        algorithm: "sha256-zero-bits",
        difficulty: 10,
        count: 3,
      });
      nonces.forEach((nonce, i) => {
        const digest = createHash("sha256").update(`${challenge}.${i}.${nonce}`).digest();
        expect(digest[0]).toBe(0);
        expect(digest[1] >> 6).toBe(0);
      });
    }
  });

  it("refuses unknown algorithms and too much work", () => {
    const base = { challenge: "c", algorithm: "sha256-zero-bits", difficulty: 18, count: 32 };
    expect(() => assertSolvable(base)).not.toThrow();
    expect(() => assertSolvable({ ...base, algorithm: "scrypt" })).toThrow(PowError);
    expect(() => assertSolvable({ ...base, difficulty: 22 })).toThrow(/2\^26/);
    expect(() => assertSolvable({ ...base, count: 0 })).toThrow(PowError);
    expect(() => assertSolvable({ ...base, difficulty: 1.5 })).toThrow(PowError);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    const solving = solveChallenge(
      { challenge: "abort", algorithm: "sha256-zero-bits", difficulty: 24, count: 2 },
      { signal: controller.signal, yieldEveryMs: 5 }
    );
    setTimeout(() => controller.abort(new Error("stop")), 20);
    await expect(solving).rejects.toThrow("stop");
  });
});
