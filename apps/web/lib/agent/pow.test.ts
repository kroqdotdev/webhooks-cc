import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  adaptiveDifficulty,
  hasLeadingZeroBits,
  issueChallenge,
  solveChallenge,
  verifySolution,
} from "./pow";
// Shared with the SDK's solver tests: both must find these nonces.
import fixture from "./pow-vectors.json";

const SECRET = "unit-test-secret-at-least-32-characters";
const AUDIENCE = "https://webhooks.cc";
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

function issue(overrides: Partial<{ difficulty: number; count: number; now: number }> = {}) {
  return issueChallenge({
    secret: SECRET,
    audience: AUDIENCE,
    difficulty: overrides.difficulty ?? 6,
    count: overrides.count ?? 4,
    now: overrides.now ?? NOW,
  });
}

function verify(challenge: unknown, nonces: unknown, now = NOW + 1000, secrets = [SECRET]) {
  return verifySolution({ challenge, nonces, secrets, audience: AUDIENCE, now });
}

/** Re-signs a challenge with a changed payload, as a client trying a downgrade would. */
function resign(
  challenge: string,
  change: (payload: Record<string, unknown>) => void,
  secret: string
) {
  const [prefix, payload] = challenge.split(".");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  change(decoded);
  const signed = `${prefix}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}`;
  return `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
}

describe("proof of work vectors", () => {
  test.each(fixture.vectors)("difficulty $difficulty x $count", (vector) => {
    expect(solveChallenge(vector.challenge, vector.difficulty, vector.count)).toEqual(
      vector.nonces
    );
    const result = verifySolution({
      challenge: vector.challenge,
      nonces: vector.nonces,
      secrets: [fixture.secret],
      audience: fixture.audience,
      now: Date.parse(fixture.issuedAt) + 10_000,
    });
    expect(result).toMatchObject({ ok: true, difficulty: vector.difficulty, count: vector.count });
  });
});

describe("issueChallenge", () => {
  test("carries its parameters and a five-minute expiry", () => {
    const c = issue({ difficulty: 7, count: 3 });
    expect(c.algorithm).toBe("sha256-zero-bits");
    expect(c.difficulty).toBe(7);
    expect(c.count).toBe(3);
    expect(Date.parse(c.expires_at)).toBe(NOW + 300_000);
    expect(c.challenge.split(".")).toHaveLength(3);
  });

  test("every challenge has its own id", () => {
    const a = verify(issue().challenge, []);
    expect(a).toEqual({ ok: false, reason: "wrong_count" });
    const one = issue({ count: 1, difficulty: 0 });
    const two = issue({ count: 1, difficulty: 0 });
    const idOne = verify(one.challenge, ["0"]);
    const idTwo = verify(two.challenge, ["0"]);
    expect(idOne.ok && idTwo.ok && idOne.id !== idTwo.id).toBe(true);
  });
});

describe("verifySolution", () => {
  const c = issue();
  const nonces = solveChallenge(c.challenge, c.difficulty, c.count);

  test("accepts a solution", () => {
    expect(verify(c.challenge, nonces)).toMatchObject({ ok: true, difficulty: 6, count: 4 });
  });

  test("accepts a challenge signed with the previous secret", () => {
    expect(
      verify(c.challenge, nonces, NOW + 1000, ["new-secret-xxxxxxxxxxxxxxxxxxxxxxx", SECRET])
    ).toMatchObject({ ok: true });
  });

  test("refuses an expired challenge, and one issued too far ahead", () => {
    expect(verify(c.challenge, nonces, NOW + 300_000)).toEqual({ ok: false, reason: "expired" });
    expect(verify(issue({ now: NOW + 120_000 }).challenge, nonces, NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("refuses a tampered challenge or another secret", () => {
    const tampered = c.challenge.slice(0, -2) + (c.challenge.endsWith("A") ? "BB" : "AA");
    expect(verify(tampered, nonces)).toEqual({ ok: false, reason: "bad_mac" });
    expect(
      verify(c.challenge, nonces, NOW + 1000, ["another-secret-xxxxxxxxxxxxxxxxxxxx"])
    ).toEqual({ ok: false, reason: "bad_mac" });
  });

  test("refuses a lowered difficulty: the parameters sit under the MAC", () => {
    const easier = resign(c.challenge, (p) => (p.d = 0), "a-guessed-secret-xxxxxxxxxxxxxxxx");
    expect(verify(easier, ["0", "0", "0", "0"])).toEqual({ ok: false, reason: "bad_mac" });
  });

  test("refuses another deployment's challenge", () => {
    const foreign = issueChallenge({
      secret: SECRET,
      audience: "https://elsewhere.example",
      difficulty: 0,
      count: 1,
      now: NOW,
    });
    expect(verify(foreign.challenge, ["0"])).toEqual({ ok: false, reason: "wrong_audience" });
  });

  test("refuses a wrong number of nonces, bad nonces and missing work", () => {
    expect(verify(c.challenge, nonces.slice(1))).toEqual({ ok: false, reason: "wrong_count" });
    expect(verify(c.challenge, "nope")).toEqual({ ok: false, reason: "wrong_count" });
    expect(verify(c.challenge, ["-1", ...nonces.slice(1)])).toEqual({
      ok: false,
      reason: "bad_nonce",
    });
    expect(verify(c.challenge, ["12345678901234567", ...nonces.slice(1)])).toEqual({
      ok: false,
      reason: "bad_nonce",
    });
    expect(verify(c.challenge, [5, ...nonces.slice(1)])).toEqual({
      ok: false,
      reason: "bad_nonce",
    });
    const shifted = [nonces[1], nonces[0], nonces[2], nonces[3]];
    expect(verify(c.challenge, shifted)).toEqual({ ok: false, reason: "insufficient_work" });
  });

  test("refuses malformed input", () => {
    expect(verify(undefined, nonces)).toEqual({ ok: false, reason: "malformed" });
    expect(verify("pow2.a.b", nonces)).toEqual({ ok: false, reason: "malformed" });
    expect(verify("x".repeat(600), nonces)).toEqual({ ok: false, reason: "malformed" });
    const notJson = `pow1.${Buffer.from("not json").toString("base64url")}`;
    const signed = `${notJson}.${createHmac("sha256", SECRET).update(notJson).digest("base64url")}`;
    expect(verify(signed, nonces)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("hasLeadingZeroBits", () => {
  test("counts whole and partial bytes", () => {
    expect(hasLeadingZeroBits(Buffer.from([0x00, 0x0f]), 12)).toBe(true);
    expect(hasLeadingZeroBits(Buffer.from([0x00, 0x1f]), 12)).toBe(false);
    expect(hasLeadingZeroBits(Buffer.from([0x80]), 0)).toBe(true);
    expect(hasLeadingZeroBits(Buffer.from([0x00, 0x00]), 16)).toBe(true);
  });
});

describe("adaptiveDifficulty", () => {
  test("adds a bit at half the pool and two at 80 percent", () => {
    expect(adaptiveDifficulty(18, 32, 0, 200)).toBe(18);
    expect(adaptiveDifficulty(18, 32, 100, 200)).toBe(19);
    expect(adaptiveDifficulty(18, 32, 160, 200)).toBe(20);
  });

  test("never asks for more than 2^26 hashes in all", () => {
    expect(adaptiveDifficulty(24, 32, 200, 200)).toBe(21);
    expect(adaptiveDifficulty(24, 64, 0, 200)).toBe(20);
    expect(adaptiveDifficulty(18, 32, 0, 0)).toBe(20);
  });
});
