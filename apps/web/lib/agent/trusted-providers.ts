import * as jose from "jose";
import { z } from "zod";
import { serverEnv } from "@/lib/env";

/**
 * Trusted ID-JAG providers for the agent auth.md identity_assertion flow.
 *
 * Providers are configured via the `AGENT_IDJAG_PROVIDERS` env var (a JSON
 * array) — NOT a DB table — so the trust set is deployment config and cannot
 * be mutated at runtime. Each entry pins an issuer (`iss`) and how to resolve
 * its JWKS:
 *   - inline `jwks` (a JWK Set object) -> jose.createLocalJWKSet (hermetic;
 *     used by the integration test so no HTTP fetch is needed), or
 *   - `jwks_uri` (or the default `${iss}/.well-known/jwks.json`) ->
 *     jose.createRemoteJWKSet (cached, refetches once on a kid miss).
 *
 * Empty default (`"[]"`) means ID-JAG is advertised in discovery but no
 * providers are trusted, so any assertion resolves to `invalid_issuer`.
 */

const trustedProviderSchema = z.object({
  /** Issuer identifier — must be an absolute https URL matching the JWT `iss`. */
  iss: z.string().url(),
  /** Optional explicit JWKS endpoint. Defaults to `${iss}/.well-known/jwks.json`. */
  jwks_uri: z.string().url().optional(),
  /** Optional inline JWK Set (for hermetic tests / static keys). */
  jwks: z.unknown().optional(),
  /** Permitted signing algorithms for this provider. */
  algs: z.array(z.string()).default(["ES256", "RS256"]),
});

export type TrustedProvider = z.infer<typeof trustedProviderSchema>;

const trustedProvidersSchema = z.array(trustedProviderSchema);

/** JWKS resolver function compatible with jose.jwtVerify's key argument. */
type JwksResolver = ReturnType<typeof jose.createRemoteJWKSet>;

let _providers: TrustedProvider[] | null = null;
const _resolvers = new Map<string, JwksResolver>();

function loadProviders(): TrustedProvider[] {
  if (_providers) return _providers;

  const raw = serverEnv().AGENT_IDJAG_PROVIDERS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_IDJAG_PROVIDERS is not valid JSON");
  }

  _providers = trustedProvidersSchema.parse(parsed);
  return _providers;
}

/**
 * Look up a trusted provider by its issuer. Returns null when the issuer is
 * not in the configured trust set (caller maps this to `invalid_issuer`).
 */
export function getTrustedProvider(iss: string): TrustedProvider | null {
  return loadProviders().find((p) => p.iss === iss) ?? null;
}

/**
 * Resolve (and memoize) the JWKS key resolver for a trusted provider. Inline
 * `jwks` yields a local key set; otherwise a remote, caching key set is built
 * from `jwks_uri` (or the well-known default).
 */
export function getJwksResolver(provider: TrustedProvider): JwksResolver {
  const cached = _resolvers.get(provider.iss);
  if (cached) return cached;

  let resolver: JwksResolver;
  if (provider.jwks !== undefined) {
    // Local JWK Set — no network. jose's createLocalJWKSet and the remote
    // variant share the same call signature for jwtVerify.
    resolver = jose.createLocalJWKSet(
      provider.jwks as Parameters<typeof jose.createLocalJWKSet>[0]
    ) as unknown as JwksResolver;
  } else {
    const url = new URL(provider.jwks_uri ?? `${provider.iss}/.well-known/jwks.json`);
    resolver = jose.createRemoteJWKSet(url);
  }

  _resolvers.set(provider.iss, resolver);
  return resolver;
}

/** Test-only: reset the memoized providers + resolvers (after mutating env). */
export function __resetTrustedProviders(): void {
  _providers = null;
  _resolvers.clear();
}
