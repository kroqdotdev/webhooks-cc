import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import * as jose from "jose";
import { publicEnv, serverEnv } from "@/lib/env";

/**
 * Service-signed identity assertions (auth.md v0.2 and later). Registration
 * hands the agent one; the jwt-bearer grant at /api/oauth2/token exchanges it
 * for an access token. ES256, header `typ: oauth-id-jag+jwt` with the key's
 * kid, `iss = aud = NEXT_PUBLIC_APP_URL`, `sub` = the registration id, and a
 * `stage` claim: `pre_claim` for an unclaimed registration, `claimed` (with
 * the claimant's email) after a claim.
 *
 * The assertion is only a pointer: every exchange reads the registration
 * again, so revoking or claiming it takes effect at once.
 */

export type AssertionStage = "pre_claim" | "claimed";

const TYP = "oauth-id-jag+jwt";
const ALG = "ES256";
/** Seconds of clock skew allowed between instances. */
const CLOCK_TOLERANCE_SECONDS = 30;

interface VerificationKey {
  kid: string;
  key: KeyObject | CryptoKey | Uint8Array;
}

interface SigningKeys {
  privateKey: KeyObject;
  kid: string;
  publicJwk: jose.JWK;
  previousJwk: jose.JWK | null;
  verification: VerificationKey[];
}

let cached: Promise<SigningKeys | null> | null = null;

/** Clears the loaded keys; tests change the env between cases. */
export function __resetAssertionKeys(): void {
  cached = null;
}

async function loadKeys(): Promise<SigningKeys | null> {
  const env = serverEnv();
  if (!env.AGENT_ASSERTION_SIGNING_KEY) return null;

  const privateKey = createPrivateKey(env.AGENT_ASSERTION_SIGNING_KEY.replace(/\\n/g, "\n"));
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error("AGENT_ASSERTION_SIGNING_KEY must be a P-256 (prime256v1) EC private key");
  }
  const publicKey = createPublicKey(privateKey);
  const { kty, crv, x, y } = publicKey.export({ format: "jwk" });
  const publicJwk: jose.JWK = { kty, crv, x, y };
  const kid = env.AGENT_ASSERTION_SIGNING_KID ?? (await jose.calculateJwkThumbprint(publicJwk));

  const verification: VerificationKey[] = [{ kid, key: publicKey }];
  let previousJwk: jose.JWK | null = null;
  if (env.AGENT_ASSERTION_PREVIOUS_PUBLIC_JWK) {
    const parsed = JSON.parse(env.AGENT_ASSERTION_PREVIOUS_PUBLIC_JWK) as jose.JWK;
    if (parsed.kty !== "EC" || parsed.crv !== "P-256" || !parsed.kid || "d" in parsed) {
      throw new Error("AGENT_ASSERTION_PREVIOUS_PUBLIC_JWK must be a public P-256 JWK with a kid");
    }
    previousJwk = { kty: parsed.kty, crv: parsed.crv, x: parsed.x, y: parsed.y, kid: parsed.kid };
    verification.push({ kid: parsed.kid, key: await jose.importJWK(previousJwk, ALG) });
  }

  return { privateKey, kid, publicJwk, previousJwk, verification };
}

function keys(): Promise<SigningKeys | null> {
  if (!cached) {
    cached = loadKeys().catch((error) => {
      // A broken key must not be retried on every request, nor hidden.
      console.error("[agent] assertion signing key is unusable:", (error as Error).message);
      return null;
    });
  }
  return cached;
}

/** False when no signing key is configured (or it does not load). */
export async function assertionSigningConfigured(): Promise<boolean> {
  return (await keys()) !== null;
}

export async function signAssertion(input: {
  registrationId: string;
  stage: AssertionStage;
  expiresAt: Date;
  email?: string | null;
}): Promise<string> {
  const loaded = await keys();
  if (!loaded) throw new Error("Agent assertion signing key is not configured");
  const issuer = publicEnv().NEXT_PUBLIC_APP_URL;
  const claims: jose.JWTPayload = { stage: input.stage };
  if (input.email) {
    claims.email = input.email;
    claims.email_verified = true;
  }
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: ALG, typ: TYP, kid: loaded.kid })
    .setIssuer(issuer)
    .setAudience(issuer)
    .setSubject(input.registrationId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(input.expiresAt.getTime() / 1000))
    .sign(loaded.privateKey);
}

export type AssertionVerification =
  { ok: true; registrationId: string; stage: AssertionStage; expiresAt: Date } | { ok: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Signature, typ, alg, issuer, audience and expiry; nothing about the registration. */
export async function verifyAssertion(jwt: string): Promise<AssertionVerification> {
  const loaded = await keys();
  if (!loaded || jwt.length > 4096) return { ok: false };
  const issuer = publicEnv().NEXT_PUBLIC_APP_URL;
  try {
    const { payload } = await jose.jwtVerify(
      jwt,
      (header) => {
        const match = loaded.verification.find((candidate) => candidate.kid === header.kid);
        if (!match) throw new Error("unknown kid");
        return match.key;
      },
      {
        issuer,
        audience: issuer,
        algorithms: [ALG],
        typ: TYP,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ["sub", "exp", "iat", "jti"],
      }
    );
    const stage = payload.stage;
    if (
      typeof payload.sub !== "string" ||
      !UUID.test(payload.sub) ||
      (stage !== "pre_claim" && stage !== "claimed") ||
      typeof payload.exp !== "number"
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      registrationId: payload.sub,
      stage,
      expiresAt: new Date(payload.exp * 1000),
    };
  } catch {
    return { ok: false };
  }
}

/** The public keys for /.well-known/jwks.json: current first, then the retired one. */
export async function buildJwks(): Promise<{ keys: jose.JWK[] }> {
  const loaded = await keys();
  if (!loaded) return { keys: [] };
  const current: jose.JWK = { ...loaded.publicJwk, kid: loaded.kid, alg: ALG, use: "sig" };
  return {
    keys: loaded.previousJwk
      ? [current, { ...loaded.previousJwk, alg: ALG, use: "sig" }]
      : [current],
  };
}
