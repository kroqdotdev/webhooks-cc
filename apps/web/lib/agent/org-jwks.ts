import * as jose from "jose";
import { sendOptions } from "@/lib/forwarding/config";
import { sendForward } from "@/lib/forwarding/send";

/**
 * Signing keys of an organisation ID-JAG issuer (lib/agent/org-id-jag.ts).
 *
 * Claude's issuers publish `<iss>/.well-known/openid-configuration` holding
 * `issuer` and `jwks_uri`, and the keys live only at that `jwks_uri`
 * (https://claude.com/docs/connectors/building/enterprise-managed-auth: "fetch
 * `<iss>/.well-known/openid-configuration`, confirm that the document's
 * `issuer` equals `iss`, and fetch the key set from the document's
 * `jwks_uri`"; refetch when an unseen `kid` appears, never pin one key).
 * Keys named in a token's own header (jwk, jku, x5c) are never used.
 *
 * Both documents are fetched through the notify proxy when one is configured,
 * like Client ID Metadata Documents (lib/oauth/clients.ts), so the box's IP
 * stays hidden, else directly with the forwarding SSRF rules. The proxy and
 * the direct path return the first 1024 bytes, which caps both documents: a
 * P-256 key is about 200 bytes, so a few keys fit. Only P-256 signing keys
 * are kept, since ES256 is the one algorithm accepted.
 *
 * Kept in memory for a few minutes; a kid nobody has seen refetches at most
 * every REFETCH_COOLDOWN_MS, so tokens with made-up kids cannot hammer the
 * issuer through us.
 */

const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5 * 60_000;
const NEGATIVE_CACHE_TTL_MS = 60_000;
const REFETCH_COOLDOWN_MS = 30_000;
const CACHE_MAX_ENTRIES = 200;
/** What the proxy and the direct path hand back at most. */
export const MAX_DOCUMENT_BYTES = 1024;

export class OrgJwksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgJwksError";
  }
}

type KeySet = ReturnType<typeof jose.createLocalJWKSet>;

interface Entry {
  keys: KeySet | null;
  reason?: string;
  until: number;
  fetchedAt: number;
}

const cache = new Map<string, Entry>();

/** Drops cached key sets (tests). */
export function clearOrgJwksCache(): void {
  cache.clear();
}

function remember(issuer: string, entry: Entry): void {
  if (!cache.has(issuer) && cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(issuer, entry);
}

async function fetchDocument(url: string, label: string): Promise<unknown> {
  const result = await sendForward(
    {
      method: "GET",
      url,
      headers: [
        ["accept", "application/json"],
        ["user-agent", "webhooks.cc agent auth (ID-JAG keys)"],
      ],
      body: null,
      mode: "relay",
    },
    { ...sendOptions(), timeoutMs: FETCH_TIMEOUT_MS }
  );
  if (result.error || result.status !== 200 || !result.excerpt) {
    throw new OrgJwksError(
      result.error
        ? `The issuer's ${label} could not be fetched.`
        : `The issuer's ${label} answered HTTP ${result.status ?? "nothing"}.`
    );
  }
  if (Buffer.byteLength(result.excerpt, "utf8") >= MAX_DOCUMENT_BYTES) {
    throw new OrgJwksError(`The issuer's ${label} is larger than ${MAX_DOCUMENT_BYTES} bytes.`);
  }
  try {
    return JSON.parse(result.excerpt);
  } catch {
    throw new OrgJwksError(`The issuer's ${label} is not JSON.`);
  }
}

/** The discovery document's address: the issuer with the well-known suffix. */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
}

/**
 * Checks the discovery document and returns its jwks_uri: the document names
 * this exact issuer, and the key set is https on the issuer's own host.
 */
export function jwksUriFromDiscovery(issuer: string, document: unknown): string {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new OrgJwksError("The issuer's discovery document is not a JSON object.");
  }
  const doc = document as Record<string, unknown>;
  if (doc.issuer !== issuer) {
    throw new OrgJwksError("The issuer's discovery document names another issuer.");
  }
  if (typeof doc.jwks_uri !== "string") {
    throw new OrgJwksError("The issuer's discovery document has no jwks_uri.");
  }
  let url: URL;
  try {
    url = new URL(doc.jwks_uri);
  } catch {
    throw new OrgJwksError("The issuer's jwks_uri is not a URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new OrgJwksError("The issuer's jwks_uri must be an https URL.");
  }
  if (url.host !== new URL(issuer).host) {
    throw new OrgJwksError("The issuer's jwks_uri is on another host.");
  }
  return url.href;
}

/** Keeps the P-256 signing keys of a JWK Set; throws when none is left. */
export function signingKeys(document: unknown): jose.JSONWebKeySet {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new OrgJwksError("The issuer's key set is not a JSON object.");
  }
  const keys = (document as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) {
    throw new OrgJwksError("The issuer's key set has no keys.");
  }
  const usable = keys.filter((key): key is jose.JWK => {
    if (!key || typeof key !== "object") return false;
    const jwk = key as Record<string, unknown>;
    return (
      jwk.kty === "EC" &&
      jwk.crv === "P-256" &&
      typeof jwk.x === "string" &&
      typeof jwk.y === "string" &&
      jwk.d === undefined &&
      (jwk.alg === undefined || jwk.alg === "ES256") &&
      (jwk.use === undefined || jwk.use === "sig")
    );
  });
  if (usable.length === 0) {
    throw new OrgJwksError("The issuer's key set has no ES256 signing key.");
  }
  return { keys: usable };
}

async function load(issuer: string): Promise<KeySet> {
  const now = Date.now();
  try {
    const discovery = await fetchDocument(discoveryUrl(issuer), "discovery document");
    const jwksUri = jwksUriFromDiscovery(issuer, discovery);
    const jwks = signingKeys(await fetchDocument(jwksUri, "key set"));
    const keys = jose.createLocalJWKSet(jwks);
    remember(issuer, { keys, until: now + CACHE_TTL_MS, fetchedAt: now });
    return keys;
  } catch (error) {
    const reason =
      error instanceof OrgJwksError ? error.message : "The issuer's keys could not be fetched.";
    remember(issuer, { keys: null, reason, until: now + NEGATIVE_CACHE_TTL_MS, fetchedAt: now });
    throw new OrgJwksError(reason);
  }
}

async function keySet(issuer: string): Promise<KeySet> {
  const cached = cache.get(issuer);
  if (cached && cached.until > Date.now()) {
    if (cached.keys) return cached.keys;
    throw new OrgJwksError(cached.reason ?? "The issuer's keys could not be fetched.");
  }
  return load(issuer);
}

/**
 * A key resolver for jose.jwtVerify. A kid missing from the cached set
 * refetches once, unless the set was fetched within the cooldown.
 */
export function orgKeyResolver(issuer: string): jose.JWTVerifyGetKey {
  return async (header, token) => {
    const keys = await keySet(issuer);
    try {
      return await keys(header, token);
    } catch (error) {
      if (!(error instanceof jose.errors.JWKSNoMatchingKey)) throw error;
      const cached = cache.get(issuer);
      if (cached && Date.now() - cached.fetchedAt < REFETCH_COOLDOWN_MS) throw error;
      const fresh = await load(issuer);
      return fresh(header, token);
    }
  };
}
