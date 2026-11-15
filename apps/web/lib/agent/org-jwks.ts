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
 * P-256 key is about 200 bytes, so a few keys fit. The notify proxy has no
 * mode with a larger limit (EXCERPT_BYTES in infra/notify-proxy/src/
 * worker.ts serves its forward and relay modes alike), so a document of
 * 1024 bytes or more is refused with its own audit code,
 * `keys_too_large`, and checking an issuer's two documents against the
 * limit is a step of turning the feature on. Raising it means a proxy mode
 * of its own, deployed before the web release that uses it. Only P-256
 * signing keys are kept, since ES256 is the one algorithm accepted.
 *
 * Kept in memory for a few minutes; a kid nobody has seen refetches at most
 * every REFETCH_COOLDOWN_MS, so tokens with made-up kids cannot hammer the
 * issuer through us. A refetch that fails keeps the last good key set (for
 * up to STALE_MAX_MS after it was fetched) and only records when it tried,
 * so an issuer that is briefly down, or a made-up kid during an outage,
 * never throws away keys that work. Concurrent requests for one issuer
 * share one fetch.
 */

const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5 * 60_000;
const NEGATIVE_CACHE_TTL_MS = 60_000;
const REFETCH_COOLDOWN_MS = 30_000;
/** How long after its fetch a key set is still used while refetches fail. */
const STALE_MAX_MS = 60 * 60_000;
const CACHE_MAX_ENTRIES = 200;
/** What the proxy and the direct path hand back at most. */
export const MAX_DOCUMENT_BYTES = 1024;

/** Why an issuer's keys could not be had, for the audit row. */
export type OrgJwksErrorCode = "keys_unavailable" | "keys_too_large";

export class OrgJwksError extends Error {
  constructor(
    message: string,
    readonly code: OrgJwksErrorCode = "keys_unavailable"
  ) {
    super(message);
    this.name = "OrgJwksError";
  }
}

type KeySet = ReturnType<typeof jose.createLocalJWKSet>;

interface Entry {
  /** The last good key set, or null when none was ever fetched. */
  keys: KeySet | null;
  /** When `keys` was fetched. */
  keysFetchedAt: number;
  reason?: string;
  code?: OrgJwksErrorCode;
  /** Until when the entry is used without asking again. */
  until: number;
  /** The last attempt, good or not: the cooldown counts from here. */
  attemptedAt: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<KeySet>>();

/** Drops cached key sets (tests). */
export function clearOrgJwksCache(): void {
  cache.clear();
  inflight.clear();
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
    throw new OrgJwksError(
      `The issuer's ${label} is larger than the ${MAX_DOCUMENT_BYTES} bytes the outbound fetch returns.`,
      "keys_too_large"
    );
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

async function fetchKeys(issuer: string): Promise<KeySet> {
  const now = Date.now();
  const previous = cache.get(issuer);
  try {
    const discovery = await fetchDocument(discoveryUrl(issuer), "discovery document");
    const jwksUri = jwksUriFromDiscovery(issuer, discovery);
    const jwks = signingKeys(await fetchDocument(jwksUri, "key set"));
    const keys = jose.createLocalJWKSet(jwks);
    remember(issuer, {
      keys,
      keysFetchedAt: now,
      until: now + CACHE_TTL_MS,
      attemptedAt: now,
    });
    return keys;
  } catch (error) {
    const reason =
      error instanceof OrgJwksError ? error.message : "The issuer's keys could not be fetched.";
    const code = error instanceof OrgJwksError ? error.code : "keys_unavailable";
    if (previous?.keys && now - previous.keysFetchedAt < STALE_MAX_MS) {
      // Keep the keys that worked; only the attempt is new.
      remember(issuer, {
        ...previous,
        reason,
        code,
        until: now + NEGATIVE_CACHE_TTL_MS,
        attemptedAt: now,
      });
      return previous.keys;
    }
    remember(issuer, {
      keys: null,
      keysFetchedAt: 0,
      reason,
      code,
      until: now + NEGATIVE_CACHE_TTL_MS,
      attemptedAt: now,
    });
    throw new OrgJwksError(reason, code);
  }
}

/** One fetch per issuer at a time; everyone asking meanwhile shares it. */
function load(issuer: string): Promise<KeySet> {
  const running = inflight.get(issuer);
  if (running) return running;
  const promise = fetchKeys(issuer).finally(() => {
    if (inflight.get(issuer) === promise) inflight.delete(issuer);
  });
  inflight.set(issuer, promise);
  return promise;
}

async function keySet(issuer: string): Promise<KeySet> {
  const cached = cache.get(issuer);
  if (cached && cached.until > Date.now()) {
    if (cached.keys) return cached.keys;
    throw new OrgJwksError(cached.reason ?? "The issuer's keys could not be fetched.", cached.code);
  }
  return load(issuer);
}

/**
 * A key resolver for jose.jwtVerify. A kid missing from the cached set
 * refetches once, unless the issuer was asked within the cooldown.
 */
export function orgKeyResolver(issuer: string): jose.JWTVerifyGetKey {
  return async (header, token) => {
    const keys = await keySet(issuer);
    try {
      return await keys(header, token);
    } catch (error) {
      if (!(error instanceof jose.errors.JWKSNoMatchingKey)) throw error;
      const cached = cache.get(issuer);
      if (cached && Date.now() - cached.attemptedAt < REFETCH_COOLDOWN_MS) throw error;
      const fresh = await load(issuer);
      return fresh(header, token);
    }
  };
}
