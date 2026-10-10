import { createHash } from "node:crypto";
import { customAlphabet } from "nanoid";
import { publicEnv, serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database";
import { generateApiKey, hashApiKey } from "@/lib/supabase/api-keys";
import { countLiveSandboxEndpoints } from "@/lib/supabase/endpoints";
import { signAssertion, verifyAssertion } from "./assertion";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CLAIMED_ASSERTION_TTL_SECONDS,
  MAX_CLIENT_NAME,
  MAX_LIVE_TOKENS,
  POST_CLAIM_SCOPES,
  PRE_CLAIM_SCOPES,
  UNCLAIMED_LIFETIME_SECONDS,
} from "./constants";
import { AgentError } from "./errors";
import type { IdJagSuccess } from "./id-jag";

/**
 * Agent registrations (auth.md v0.6). One `agent_registrations` row per
 * registration owns everything the agent holds: its access tokens (`whcc_`
 * rows in api_keys with agent_registration_id and an expiry), its sandbox
 * endpoints and the sandbox budget. The identity assertion handed to the
 * agent only names the row, so every exchange reads it again.
 *
 * Pre-claim tokens have no user: the bearer check lets them through, and the
 * routes that need a user refuse them, so the sandbox routes are the only
 * place they work.
 */

type RegistrationRow = Database["public"]["Tables"]["agent_registrations"]["Row"];

const generateClaimTokenBody = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  32
);

/** `clm_` + 32 base62 characters; only its SHA-256 is stored. */
export function generateClaimToken(): string {
  return `clm_${generateClaimTokenBody()}`;
}

export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The agent's self-reported name: trimmed, control characters dropped, cut
 * to the column's 64 characters. Shown to humans only labelled as
 * self-reported.
 */
export function cleanClientName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return cleaned ? cleaned.slice(0, MAX_CLIENT_NAME) : null;
}

function appUrl(): string {
  return publicEnv().NEXT_PUBLIC_APP_URL;
}

export function claimEndpointUrl(): string {
  return `${appUrl()}/api/agent/identity/claim`;
}

export function sandboxEndpointsUrl(): string {
  return `${appUrl()}/api/agent/sandbox/endpoints`;
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = error as { code?: string; message?: string; details?: string };
  if (pg?.code !== "23505") return false;
  if (!constraint) return true;
  return `${pg.message ?? ""} ${pg.details ?? ""}`.includes(constraint);
}

// ---------------------------------------------------------------------------
// Pool usage, cached briefly: every challenge reads it for its difficulty.
// ---------------------------------------------------------------------------

const POOL_CACHE_MS = 10_000;
let poolCache: { value: number; at: number } | null = null;

export async function sandboxPoolUsage(): Promise<number> {
  const now = Date.now();
  if (poolCache && now - poolCache.at < POOL_CACHE_MS) return poolCache.value;
  const value = await countLiveSandboxEndpoints();
  poolCache = { value, at: now };
  return value;
}

/** Drops the cached count after a change to the pool (and between tests). */
export function invalidatePoolUsage(): void {
  poolCache = null;
}

// ---------------------------------------------------------------------------
// Anonymous registration
// ---------------------------------------------------------------------------

export interface AnonymousRegistration {
  registration: RegistrationRow;
  claimToken: string;
  assertion: string;
  sandboxFull: boolean;
}

async function liveAnonymousCount(): Promise<number> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("agent_registrations")
    .select("id", { count: "exact", head: true })
    .eq("kind", "anonymous")
    .is("claimed_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString());
  if (error) throw error;
  return count ?? 0;
}

/**
 * Creates an anonymous registration for a verified proof of work. The
 * challenge id goes into a unique column, so a challenge registers once; a
 * refusal before the insert (the live cap) leaves it usable until it expires.
 */
export async function createAnonymousRegistration(input: {
  clientName: string | null;
  powChallengeId: string;
}): Promise<AnonymousRegistration> {
  if ((await liveAnonymousCount()) >= serverEnv().AGENT_MAX_LIVE_ANONYMOUS) {
    throw new AgentError(
      503,
      "temporarily_unavailable",
      "Too many unclaimed agent registrations right now. Retry later.",
      {},
      { "Retry-After": "600" }
    );
  }

  const claimToken = generateClaimToken();
  const expiresAt = new Date(Date.now() + UNCLAIMED_LIFETIME_SECONDS * 1000);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_registrations")
    .insert({
      kind: "anonymous",
      client_name: input.clientName,
      claim_token_hash: hashClaimToken(claimToken),
      expires_at: expiresAt.toISOString(),
      pow_challenge_id: input.powChallengeId,
    })
    .select("*")
    .single();

  if (error) {
    if (isUniqueViolation(error, "pow_challenge_id")) {
      throw new AgentError(
        400,
        "invalid_challenge",
        "This proof-of-work challenge was already used. Request a new one."
      );
    }
    throw error;
  }

  const assertion = await signAssertion({
    registrationId: data.id,
    stage: "pre_claim",
    expiresAt,
  });

  const sandboxFull = (await sandboxPoolUsage()) >= serverEnv().AGENT_SANDBOX_MAX_ENDPOINTS;
  return { registration: data, claimToken, assertion, sandboxFull };
}

// ---------------------------------------------------------------------------
// identity_assertion (ID-JAG). Ported unchanged from the v0.1 flow: no
// trusted provider exists (AGENT_IDJAG_PROVIDERS is empty in production), and
// the auth_time and interaction_required checks v0.5 asks for come before any
// provider is trusted.
// ---------------------------------------------------------------------------

export interface IdJagRegistration {
  registration: RegistrationRow;
  assertion: string;
  assertionExpires: Date;
}

export async function createIdJagRegistration(
  verified: IdJagSuccess,
  resolveUser: (email: string, name: string | null) => Promise<string>
): Promise<IdJagRegistration> {
  // Only a verified email may resolve or provision an account; verifyIdJag
  // already drops an unverified one, and this repeats the check.
  if (!verified.email || !verified.emailVerified) {
    throw new AgentError(400, "invalid_request", "The assertion carries no verified email.");
  }
  const userId = await resolveUser(verified.email, verified.name ?? null);
  const admin = createAdminClient();
  const now = new Date();

  // One live registration per (iss, sub): a repeat registration gets a new
  // assertion for the same row.
  const { data: existing, error: lookupError } = await admin
    .from("agent_registrations")
    .select("*")
    .eq("idjag_iss", verified.iss)
    .eq("idjag_sub", verified.sub)
    .is("revoked_at", null)
    .maybeSingle();
  if (lookupError) throw lookupError;

  let registration = existing;
  if (!registration) {
    const { data, error } = await admin
      .from("agent_registrations")
      .insert({
        kind: "identity_assertion",
        user_id: userId,
        claimed_at: now.toISOString(),
        // expires_at is the unclaimed lifetime; a registration claimed from
        // the start has none left.
        expires_at: now.toISOString(),
        idjag_iss: verified.iss,
        idjag_sub: verified.sub,
      })
      .select("*")
      .single();
    if (error) {
      // A concurrent registration of the same identity won the insert.
      if (!isUniqueViolation(error)) throw error;
      const { data: winner, error: winnerError } = await admin
        .from("agent_registrations")
        .select("*")
        .eq("idjag_iss", verified.iss)
        .eq("idjag_sub", verified.sub)
        .is("revoked_at", null)
        .single();
      if (winnerError) throw winnerError;
      registration = winner;
    } else {
      registration = data;
    }
  }
  if (registration.user_id !== userId) {
    throw new AgentError(400, "invalid_request", "This identity is linked to another account.");
  }

  const assertionExpires = new Date(now.getTime() + CLAIMED_ASSERTION_TTL_SECONDS * 1000);
  const assertion = await signAssertion({
    registrationId: registration.id,
    stage: "claimed",
    expiresAt: assertionExpires,
    email: verified.email.toLowerCase(),
  });
  return { registration, assertion, assertionExpires };
}

// ---------------------------------------------------------------------------
// Token exchange (jwt-bearer grant) and revocation
// ---------------------------------------------------------------------------

export interface AccessToken {
  accessToken: string;
  expiresIn: number;
  scope: string;
  registration: RegistrationRow;
}

/** The grant failed: RFC 6749 `invalid_grant`, restart at registration. */
export class InvalidGrantError extends Error {
  constructor(readonly description: string) {
    super(description);
    this.name = "InvalidGrantError";
  }
}

export async function exchangeAssertion(assertion: string): Promise<AccessToken> {
  const verified = await verifyAssertion(assertion);
  if (!verified.ok) {
    throw new InvalidGrantError("The assertion is invalid or expired.");
  }

  const admin = createAdminClient();
  const { data: registration, error } = await admin
    .from("agent_registrations")
    .select("*")
    .eq("id", verified.registrationId)
    .maybeSingle();
  if (error) throw error;
  if (!registration || registration.revoked_at) {
    throw new InvalidGrantError("The registration was revoked or no longer exists.");
  }

  const now = Date.now();
  let userId: string | null;
  let scopes: string[];
  let expiresAtMs: number;
  if (registration.claimed_at) {
    // A claim makes every pre-claim assertion useless: the agent that held
    // the claim token received a claimed one.
    if (verified.stage !== "claimed" || !registration.user_id) {
      throw new InvalidGrantError(
        "This registration has been claimed. Use the assertion issued with the claim."
      );
    }
    userId = registration.user_id;
    scopes = POST_CLAIM_SCOPES;
    expiresAtMs = now + ACCESS_TOKEN_TTL_SECONDS * 1000;
  } else {
    const registrationExpires = Date.parse(registration.expires_at);
    if (
      registration.kind !== "anonymous" ||
      verified.stage !== "pre_claim" ||
      registrationExpires <= now
    ) {
      throw new InvalidGrantError("The registration has expired.");
    }
    userId = null;
    scopes = PRE_CLAIM_SCOPES;
    expiresAtMs = Math.min(now + ACCESS_TOKEN_TTL_SECONDS * 1000, registrationExpires);
  }

  const rawKey = generateApiKey();
  const { error: insertError } = await admin.from("api_keys").insert({
    user_id: userId,
    key_hash: hashApiKey(rawKey),
    key_prefix: rawKey.slice(0, 12),
    name: registration.client_name
      ? `Agent token (${registration.client_name})`
      : `Agent token (${registration.kind})`,
    expires_at: new Date(expiresAtMs).toISOString(),
    scopes,
    is_agent_issued: true,
    client_name: registration.client_name,
    claimed_at: registration.claimed_at,
    agent_registration_id: registration.id,
  });
  if (insertError) throw insertError;

  await pruneTokens(registration.id);

  return {
    accessToken: rawKey,
    expiresIn: Math.max(1, Math.floor((expiresAtMs - now) / 1000)),
    scope: scopes.join(" "),
    registration,
  };
}

/** Keeps the newest MAX_LIVE_TOKENS tokens of a registration. */
async function pruneTokens(registrationId: string): Promise<void> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_keys")
    .select("id")
    .eq("agent_registration_id", registrationId)
    .order("created_at", { ascending: false })
    .range(MAX_LIVE_TOKENS, MAX_LIVE_TOKENS + 50);
  if (error) throw error;
  const stale = (data ?? []).map((row) => row.id);
  if (stale.length === 0) return;
  const { error: deleteError } = await admin.from("api_keys").delete().in("id", stale);
  if (deleteError) throw deleteError;
}

/**
 * RFC 7009: deletes the token when it is an agent access token. Dashboard
 * and device keys are never touched here. Returns the registration it
 * belonged to, or null when nothing was deleted.
 */
export async function revokeAgentToken(token: string): Promise<string | null> {
  if (!token.startsWith("whcc_") || token.length > 128) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_keys")
    .delete()
    .eq("key_hash", hashApiKey(token))
    .not("agent_registration_id", "is", null)
    .select("agent_registration_id")
    .maybeSingle();
  if (error) throw error;
  return data?.agent_registration_id ?? null;
}

// ---------------------------------------------------------------------------
// Sandbox access
// ---------------------------------------------------------------------------

export type SandboxAccess =
  { ok: true; registration: RegistrationRow } | { ok: false; reason: "not_sandbox" | "closed" };

/**
 * The registration behind a pre-claim token, when it may still use the
 * sandbox: anonymous, unclaimed, not revoked and not expired. Read on every
 * call, so a claim or a revoke closes the sandbox at once.
 */
export async function sandboxRegistration(auth: {
  userId: string | null;
  agentRegistrationId?: string | null;
}): Promise<SandboxAccess> {
  if (!auth.agentRegistrationId) return { ok: false, reason: "not_sandbox" };
  if (auth.userId !== null) return { ok: false, reason: "closed" };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_registrations")
    .select("*")
    .eq("id", auth.agentRegistrationId)
    .maybeSingle();
  if (error) throw error;
  if (
    !data ||
    data.kind !== "anonymous" ||
    data.claimed_at ||
    data.revoked_at ||
    Date.parse(data.expires_at) <= Date.now()
  ) {
    return { ok: false, reason: "closed" };
  }
  return { ok: true, registration: data };
}
