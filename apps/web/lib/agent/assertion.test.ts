import { generateKeyPairSync } from "node:crypto";
import * as jose from "jose";
import { afterEach, describe, expect, test } from "vitest";

// serverEnv() and publicEnv() parse lazily on first call, so these must be
// set before any test runs; the values are dummies apart from the key.
process.env.NEXT_PUBLIC_APP_URL = "https://webhooks.cc";
process.env.NEXT_PUBLIC_WEBHOOK_URL ??= "https://go.webhooks.cc";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.CAPTURE_SHARED_SECRET ??= "test-capture-secret";
process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.RECEIVER_INTERNAL_URL ??= "http://localhost:3001";

function newKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

// Written the way an env file holds it: one line, newlines as \n.
process.env.AGENT_ASSERTION_SIGNING_KEY = newKeyPem().replace(/\n/g, "\\n");
delete process.env.AGENT_ASSERTION_SIGNING_KID;
delete process.env.AGENT_ASSERTION_PREVIOUS_PUBLIC_JWK;

import { serverEnv } from "@/lib/env";
import {
  __resetAssertionKeys,
  assertionSigningConfigured,
  buildJwks,
  signAssertion,
  verifyAssertion,
} from "./assertion";

const REGISTRATION = "0b8a2c4e-1f3d-4a5b-9c6d-7e8f9a0b1c2d";
const env = serverEnv() as unknown as Record<string, string | undefined>;
const originalKey = env.AGENT_ASSERTION_SIGNING_KEY;

function inOneHour(): Date {
  return new Date(Date.now() + 3600_000);
}

afterEach(() => {
  env.AGENT_ASSERTION_SIGNING_KEY = originalKey;
  env.AGENT_ASSERTION_SIGNING_KID = undefined;
  env.AGENT_ASSERTION_PREVIOUS_PUBLIC_JWK = undefined;
  __resetAssertionKeys();
});

describe("identity assertions", () => {
  test("round-trips a pre-claim assertion", async () => {
    expect(await assertionSigningConfigured()).toBe(true);
    const jwt = await signAssertion({
      registrationId: REGISTRATION,
      stage: "pre_claim",
      expiresAt: inOneHour(),
    });
    const header = jose.decodeProtectedHeader(jwt);
    expect(header).toMatchObject({ alg: "ES256", typ: "oauth-id-jag+jwt" });
    const claims = jose.decodeJwt(jwt);
    expect(claims).toMatchObject({
      iss: "https://webhooks.cc",
      aud: "https://webhooks.cc",
      sub: REGISTRATION,
      stage: "pre_claim",
    });
    expect(claims.email).toBeUndefined();
    expect(await verifyAssertion(jwt)).toMatchObject({
      ok: true,
      registrationId: REGISTRATION,
      stage: "pre_claim",
    });
  });

  test("a claimed assertion carries the verified email", async () => {
    const jwt = await signAssertion({
      registrationId: REGISTRATION,
      stage: "claimed",
      expiresAt: inOneHour(),
      email: "dev@example.com",
    });
    expect(jose.decodeJwt(jwt)).toMatchObject({ email: "dev@example.com", email_verified: true });
    expect(await verifyAssertion(jwt)).toMatchObject({ ok: true, stage: "claimed" });
  });

  test("the kid defaults to the RFC 7638 thumbprint and is published in JWKS", async () => {
    const jwt = await signAssertion({
      registrationId: REGISTRATION,
      stage: "pre_claim",
      expiresAt: inOneHour(),
    });
    const { keys } = await buildJwks();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(keys[0]).not.toHaveProperty("d");
    expect(jose.decodeProtectedHeader(jwt).kid).toBe(
      await jose.calculateJwkThumbprint({
        kty: keys[0].kty,
        crv: keys[0].crv,
        x: keys[0].x,
        y: keys[0].y,
      })
    );
  });

  test("refuses expired, tampered and foreign assertions", async () => {
    const expired = await signAssertion({
      registrationId: REGISTRATION,
      stage: "pre_claim",
      expiresAt: new Date(Date.now() - 120_000),
    });
    expect(await verifyAssertion(expired)).toEqual({ ok: false });

    const good = await signAssertion({
      registrationId: REGISTRATION,
      stage: "pre_claim",
      expiresAt: inOneHour(),
    });
    const [h, , s] = good.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...jose.decodeJwt(good), stage: "claimed" })
    ).toString("base64url");
    expect(await verifyAssertion(`${h}.${forged}.${s}`)).toEqual({ ok: false });

    // Same claims and kid, signed by a key we do not hold.
    const { privateKey } = await jose.generateKeyPair("ES256");
    const foreign = await new jose.SignJWT({ stage: "pre_claim" })
      .setProtectedHeader({
        alg: "ES256",
        typ: "oauth-id-jag+jwt",
        kid: jose.decodeProtectedHeader(good).kid,
      })
      .setIssuer("https://webhooks.cc")
      .setAudience("https://webhooks.cc")
      .setSubject(REGISTRATION)
      .setJti("x")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    expect(await verifyAssertion(foreign)).toEqual({ ok: false });
    expect(await verifyAssertion("not.a.jwt")).toEqual({ ok: false });
  });

  test("refuses another typ", async () => {
    const pem = (env.AGENT_ASSERTION_SIGNING_KEY ?? "").replace(/\\n/g, "\n");
    const key = await jose.importPKCS8(pem, "ES256");
    const kid = (await buildJwks()).keys[0].kid;
    const jwt = await new jose.SignJWT({ stage: "pre_claim" })
      .setProtectedHeader({ alg: "ES256", typ: "JWT", kid })
      .setIssuer("https://webhooks.cc")
      .setAudience("https://webhooks.cc")
      .setSubject(REGISTRATION)
      .setJti("x")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);
    expect(await verifyAssertion(jwt)).toEqual({ ok: false });
  });

  test("after a rotation, assertions of the previous key still verify", async () => {
    env.AGENT_ASSERTION_SIGNING_KID = "old-key";
    __resetAssertionKeys();
    const oldJwt = await signAssertion({
      registrationId: REGISTRATION,
      stage: "pre_claim",
      expiresAt: inOneHour(),
    });
    const oldPublic = { ...(await buildJwks()).keys[0] };

    env.AGENT_ASSERTION_SIGNING_KEY = newKeyPem();
    env.AGENT_ASSERTION_SIGNING_KID = "new-key";
    env.AGENT_ASSERTION_PREVIOUS_PUBLIC_JWK = JSON.stringify({
      kty: oldPublic.kty,
      crv: oldPublic.crv,
      x: oldPublic.x,
      y: oldPublic.y,
      kid: "old-key",
    });
    __resetAssertionKeys();

    expect((await buildJwks()).keys.map((key) => key.kid)).toEqual(["new-key", "old-key"]);
    expect(await verifyAssertion(oldJwt)).toMatchObject({ ok: true });

    // Without the previous key the old assertion is dead.
    env.AGENT_ASSERTION_PREVIOUS_PUBLIC_JWK = undefined;
    __resetAssertionKeys();
    expect(await verifyAssertion(oldJwt)).toEqual({ ok: false });
  });

  test("without a key nothing is signed and JWKS is empty", async () => {
    env.AGENT_ASSERTION_SIGNING_KEY = undefined;
    __resetAssertionKeys();
    expect(await assertionSigningConfigured()).toBe(false);
    expect(await buildJwks()).toEqual({ keys: [] });
    await expect(
      signAssertion({ registrationId: REGISTRATION, stage: "pre_claim", expiresAt: inOneHour() })
    ).rejects.toThrow(/not configured/);
  });

  test("a key on another curve is refused", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    env.AGENT_ASSERTION_SIGNING_KEY = privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    __resetAssertionKeys();
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      expect(await assertionSigningConfigured()).toBe(false);
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
  });
});
