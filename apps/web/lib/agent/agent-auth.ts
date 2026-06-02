import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { customAlphabet } from "nanoid";
import { SupabaseClient } from "@supabase/supabase-js";
import { publicEnv, serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  defaultAgentScopes,
  generateApiKey,
  hashApiKey,
  MAX_KEYS_PER_USER,
} from "@/lib/supabase/api-keys";
import { sendEmail } from "@/lib/email/mailer";
import { verifyIdJag, type IdJagSuccess } from "./id-jag";

/**
 * Agent self-registration state machine (auth.md) backing POST /api/agent/auth.
 *
 * Three flows:
 *   - anonymous       — mint an unowned whcc_ key immediately; an in-app claim
 *                       ceremony (clm_ token) can later rebind it to a user.
 *   - verified_email  — issue an OTP, withhold the credential until the OTP is
 *                       confirmed, then mint the key bound to the verified user.
 *   - identity_assertion (ID-JAG) — verify synchronously, mint a key bound to a
 *                       matched-or-JIT-provisioned user (no claim ceremony).
 *
 * Reuses generateApiKey/hashApiKey/defaultAgentScopes and the device-auth
 * pattern. New tables (agent_claims) are accessed via an untyped admin client
 * because the generated Database types do not (yet) include them; RLS already
 * blocks all non-service access.
 */

const CLAIM_TOKEN_TTL_MS = 15 * 60 * 1000; // anonymous in-app claim window
const OTP_TTL_MS = 10 * 60 * 1000; // verified_email OTP window
const OTP_MAX_ATTEMPTS = 5;

/**
 * A client-facing error from the agent-auth flows that maps to a specific HTTP
 * status + auth.md error code. Thrown for capacity/throttle limits so the route
 * surfaces them (e.g. 429 rate_limited, 503 temporarily_unavailable) instead of
 * a generic 500.
 */
export class AgentRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
    this.name = "AgentRequestError";
  }
}

const generateClaimTokenBody = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  32
);

// Human-friendly claim code (e.g. "ABCD-EFGH"), mirroring device-auth's
// user_code: an unambiguous alphabet (no 0/O/1/I/L) a human can read off the
// agent's output and TYPE at /agent/claim. Two 4-char groups joined by a dash.
const generateUserCodePart = customAlphabet("ABCDEFGHJKMNPQRSTUVWXYZ23456789", 4);

export function generateUserCode(): string {
  return `${generateUserCodePart()}-${generateUserCodePart()}`;
}

/** Normalize a human-typed claim code: uppercase, trim, collapse to XXXX-XXXX. */
export function normalizeUserCode(input: string): string {
  const stripped = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (stripped.length === 8) {
    return `${stripped.slice(0, 4)}-${stripped.slice(4)}`;
  }
  return input.trim().toUpperCase();
}

/** Untyped admin client for new agent tables / api_keys columns. */
function db(): SupabaseClient {
  return createAdminClient() as unknown as SupabaseClient;
}

export function generateClaimToken(): string {
  return `clm_${generateClaimTokenBody()}`;
}

export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashOtp(otp: string): string {
  return createHash("sha256").update(otp).digest("hex");
}

/** Constant-time compare of two same-length hex digests. */
function digestsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Build the in-app claim URL for a claim token (mirrors /cli/verify). */
function claimUrl(): string {
  return `${publicEnv().NEXT_PUBLIC_APP_URL}/agent/claim`;
}

// ---------------------------------------------------------------------------
// Anonymous flow
// ---------------------------------------------------------------------------

export interface AnonymousRegistration {
  registration_id: string;
  registration_type: "anonymous";
  credential_type: "api_key";
  credential: string;
  credential_expires: null;
  scopes: string[];
  claim_url: string;
  claim_token: string;
  /** Short human-friendly code (e.g. "ABCD-EFGH") to claim by typing it in-app. */
  user_code: string;
  claim_token_expires: string;
  post_claim_scopes: string[];
}

/**
 * Mint an unowned (user_id NULL) whcc_ key immediately and create a pending
 * `anonymous` claim so the agent can later bind the key to a user in-app.
 */
export async function createAnonymousRegistration(args: {
  clientName?: string | null;
}): Promise<AnonymousRegistration> {
  const admin = db();

  // Global backstop on outstanding unclaimed anonymous registrations (the
  // endpoint is unauthenticated; per-IP rate limiting alone does not bound the
  // total across rotating IPs). Mirrors device-auth's MAX_PENDING_CODES guard.
  const { count: pending, error: pendingError } = await admin
    .from("agent_claims")
    .select("id", { count: "exact", head: true })
    .eq("flow", "anonymous")
    .eq("status", "pending")
    // Only live (non-expired) claims count toward the backstop; expired-but-not-
    // yet-cleaned rows would otherwise inflate the total and falsely trip 503.
    .gt("expires_at", new Date().toISOString());
  if (pendingError) throw pendingError;
  if ((pending ?? 0) >= serverEnv().AGENT_MAX_PENDING_ANONYMOUS) {
    throw new AgentRequestError(503, "temporarily_unavailable");
  }

  const scopes = defaultAgentScopes();
  const postClaimScopes = defaultAgentScopes();
  const rawKey = generateApiKey();
  const clientName = args.clientName ?? null;

  const { data: keyRow, error: keyError } = await admin
    .from("api_keys")
    .insert({
      user_id: null,
      key_hash: hashApiKey(rawKey),
      key_prefix: rawKey.slice(0, 12),
      name: clientName ? `Agent (${clientName})` : "Agent (anonymous)",
      expires_at: null,
      scopes,
      is_agent_issued: true,
      client_name: clientName,
    })
    .select("id")
    .single();

  if (keyError) throw keyError;

  const claimToken = generateClaimToken();
  const expiresAt = new Date(Date.now() + CLAIM_TOKEN_TTL_MS).toISOString();

  // Insert the claim with a fresh human-friendly user_code, retrying on the rare
  // unique-collision (partial unique index on user_code). A handful of attempts
  // is plenty given 31^8 ≈ 8.5e11 combinations vs. the small pending population.
  let claimRow: { id: string; user_code: string } | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = generateUserCode();
    const { data, error } = await admin
      .from("agent_claims")
      .insert({
        flow: "anonymous",
        claim_token_hash: hashClaimToken(claimToken),
        api_key_id: keyRow.id,
        user_code: userCode,
        pre_claim_scopes: scopes,
        post_claim_scopes: postClaimScopes,
        client_name: clientName,
        status: "pending",
        expires_at: expiresAt,
      })
      .select("id, user_code")
      .single();

    if (!error) {
      claimRow = data as { id: string; user_code: string };
      break;
    }
    // 23505 = unique_violation. Any other error is fatal.
    if ((error as { code?: string }).code !== "23505") throw error;
    lastError = error;
  }

  if (!claimRow) {
    // The api_keys row was already inserted but no claim references it. Clean it
    // up so it does not leak as an orphaned, unclaimable key (best-effort; ignore
    // delete errors), then surface the original failure.
    try {
      await admin.from("api_keys").delete().eq("id", keyRow.id);
    } catch {
      // best-effort cleanup
    }
    throw lastError ?? new Error("Failed to allocate a unique claim code");
  }

  return {
    registration_id: claimRow.id,
    registration_type: "anonymous",
    credential_type: "api_key",
    credential: rawKey,
    credential_expires: null,
    scopes,
    claim_url: claimUrl(),
    claim_token: claimToken,
    user_code: claimRow.user_code,
    claim_token_expires: expiresAt,
    post_claim_scopes: postClaimScopes,
  };
}

// ---------------------------------------------------------------------------
// In-app claim ceremony (anonymous flow)
// ---------------------------------------------------------------------------

export type ClaimPollStatus = "pending" | "claimed" | "expired" | "invalid" | "previously_claimed";

export interface ClaimPollResult {
  status: ClaimPollStatus;
  client_name?: string | null;
  post_claim_scopes?: string[];
  /** Echoed back while pending so an agent can re-surface the human-typed code. */
  user_code?: string | null;
}

type AgentClaimRow = {
  id: string;
  flow: "anonymous" | "verified_email";
  api_key_id: string | null;
  email: string | null;
  otp_hash: string | null;
  user_code: string | null;
  attempts: number;
  max_attempts: number;
  post_claim_scopes: string[];
  pre_claim_scopes: string[];
  client_name: string | null;
  status: "pending" | "claimed";
  expires_at: string;
};

const CLAIM_COLUMNS =
  "id, flow, api_key_id, email, otp_hash, user_code, attempts, max_attempts, post_claim_scopes, pre_claim_scopes, client_name, status, expires_at";

function isExpired(timestamp: string): boolean {
  return new Date(timestamp).getTime() < Date.now();
}

async function findClaimByTokenHash(tokenHash: string): Promise<AgentClaimRow | null> {
  const { data, error } = await db()
    .from("agent_claims")
    .select(CLAIM_COLUMNS)
    .eq("claim_token_hash", tokenHash)
    .maybeSingle();

  if (error) throw error;
  return (data as AgentClaimRow | null) ?? null;
}

/**
 * Poll the status of a claim token (used by the in-app claim page to reflect
 * progress, and by the agent to discover when its key has been bound).
 */
export async function pollClaim(claimToken: string): Promise<ClaimPollResult> {
  const claim = await findClaimByTokenHash(hashClaimToken(claimToken));

  if (!claim) {
    return { status: "invalid" };
  }
  if (claim.status === "claimed") {
    // Terminal poll status is "claimed" — the SDK's waitForClaim() waits for it.
    // (previously_claimed is the CLAIM/confirm result, not the poll status.)
    return { status: "claimed", client_name: claim.client_name };
  }
  if (isExpired(claim.expires_at)) {
    return { status: "expired" };
  }
  return {
    status: "pending",
    client_name: claim.client_name,
    post_claim_scopes: claim.post_claim_scopes,
    user_code: claim.user_code,
  };
}

export type ClaimAnonymousResult =
  | { ok: true; clientName: string | null; scopes: string[] }
  | {
      ok: false;
      error: "invalid_claim_token" | "claim_expired" | "previously_claimed" | "too_many_keys";
    };

/** Look up a pending anonymous claim by its human-typed user_code. */
async function findAnonymousClaimByUserCode(userCode: string): Promise<AgentClaimRow | null> {
  const { data, error } = await db()
    .from("agent_claims")
    .select(CLAIM_COLUMNS)
    .eq("user_code", normalizeUserCode(userCode))
    .eq("flow", "anonymous")
    .maybeSingle();

  if (error) throw error;
  return (data as AgentClaimRow | null) ?? null;
}

/**
 * Core binding for the anonymous claim ceremony, shared by the token-URL and the
 * human-typed-code entry paths. Atomically marks the pending claim claimed and
 * rebinds the previously-unowned api_keys row to the logged-in user, enforcing
 * MAX_KEYS_PER_USER like device-auth. The `claim` is the row resolved by either
 * the claim_token hash or the user_code; both converge here.
 */
async function bindAnonymousClaim(
  claim: AgentClaimRow | null,
  userId: string
): Promise<ClaimAnonymousResult> {
  const admin = db();

  if (!claim || claim.flow !== "anonymous" || !claim.api_key_id) {
    return { ok: false, error: "invalid_claim_token" };
  }
  if (claim.status === "claimed") {
    return { ok: false, error: "previously_claimed" };
  }
  if (isExpired(claim.expires_at)) {
    return { ok: false, error: "claim_expired" };
  }

  const { count, error: countError } = await admin
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  if (countError) throw countError;
  if ((count ?? 0) >= MAX_KEYS_PER_USER) {
    return { ok: false, error: "too_many_keys" };
  }

  // Atomically claim the pending row first (guards against double-claim).
  const { data: claimedRow, error: claimUpdateError } = await admin
    .from("agent_claims")
    .update({
      status: "claimed",
      claimed_by_user_id: userId,
    })
    .eq("id", claim.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (claimUpdateError) throw claimUpdateError;
  if (!claimedRow) {
    // Lost the race — someone else claimed it.
    return { ok: false, error: "previously_claimed" };
  }

  // Rebind the previously-unowned key to the user. If this fails, revert the
  // claim to pending so the ceremony can be retried — otherwise the claim would
  // be marked claimed while the key stays unbound (a dead, unrecoverable state).
  const { error: keyUpdateError } = await admin
    .from("api_keys")
    .update({
      user_id: userId,
      claimed_at: new Date().toISOString(),
      scopes: claim.post_claim_scopes,
    })
    .eq("id", claim.api_key_id);

  if (keyUpdateError) {
    await admin
      .from("agent_claims")
      .update({ status: "pending", claimed_by_user_id: null })
      .eq("id", claim.id);
    throw keyUpdateError;
  }

  // Compensating best-effort guard around the inherent TOCTOU between the count
  // check above and the rebind: two concurrent claims can both pass the
  // MAX_KEYS_PER_USER check and rebind, pushing the user over the cap. Re-count
  // AFTER rebinding; if we now exceed the limit, undo this rebind (return the key
  // to its unowned pre-claim state and reopen the claim) so the cap holds. This
  // is not race-free, but it converges the common concurrent case.
  const { count: postCount, error: postCountError } = await admin
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  if (postCountError) throw postCountError;
  if ((postCount ?? 0) > MAX_KEYS_PER_USER) {
    await admin
      .from("api_keys")
      .update({ user_id: null, claimed_at: null, scopes: claim.pre_claim_scopes })
      .eq("id", claim.api_key_id);
    await admin
      .from("agent_claims")
      .update({ status: "pending", claimed_by_user_id: null })
      .eq("id", claim.id);
    return { ok: false, error: "too_many_keys" };
  }

  return { ok: true, clientName: claim.client_name, scopes: claim.post_claim_scopes };
}

/**
 * Bind an anonymous registration's key to a logged-in user via the one-time
 * claim_token (the claim-link path).
 */
export async function claimAnonymousForUser(
  claimToken: string,
  userId: string
): Promise<ClaimAnonymousResult> {
  const claim = await findClaimByTokenHash(hashClaimToken(claimToken));
  return bindAnonymousClaim(claim, userId);
}

/**
 * Bind an anonymous registration's key to a logged-in user via the short,
 * human-typed user_code (the code-entry path). Equivalent ceremony to
 * claimAnonymousForUser; only the lookup differs.
 */
export async function claimAnonymousByUserCode(
  userCode: string,
  userId: string
): Promise<ClaimAnonymousResult> {
  const claim = await findAnonymousClaimByUserCode(userCode);
  return bindAnonymousClaim(claim, userId);
}

/**
 * Coarse status of an anonymous claim looked up by its human-typed user_code,
 * for the in-app code-entry page to preview before the user confirms.
 */
export async function lookupAnonymousClaimByUserCode(userCode: string): Promise<ClaimPollResult> {
  const claim = await findAnonymousClaimByUserCode(userCode);

  if (!claim || claim.flow !== "anonymous") {
    return { status: "invalid" };
  }
  if (claim.status === "claimed") {
    return { status: "previously_claimed", client_name: claim.client_name };
  }
  if (isExpired(claim.expires_at)) {
    return { status: "expired" };
  }
  return {
    status: "pending",
    client_name: claim.client_name,
    post_claim_scopes: claim.post_claim_scopes,
    user_code: claim.user_code,
  };
}

// ---------------------------------------------------------------------------
// verified_email (OTP) flow
// ---------------------------------------------------------------------------

export interface VerifiedEmailClaim {
  registration_id: string;
  registration_type: "email-verification";
  claim_url: string;
  claim_token: string;
  claim_token_expires: string;
  post_claim_scopes: string[];
}

/**
 * Begin the verified_email flow: generate a 6-digit OTP (stored hashed only),
 * a clm_ claim token, persist a pending verified_email claim, and email the OTP.
 * The credential is withheld until the OTP is confirmed.
 */
export async function issueVerifiedEmailClaim(args: {
  email: string;
  clientName?: string | null;
}): Promise<VerifiedEmailClaim> {
  const admin = db();
  const email = args.email.toLowerCase();
  const clientName = args.clientName ?? null;
  const postClaimScopes = defaultAgentScopes();

  // Per-email throttle: cap concurrent pending OTP claims for one address so an
  // attacker cannot mint unlimited OTPs (anti-spam) and cannot widen the guess
  // budget by issuing many parallel claims (brute-force defense). Emails are
  // stored lowercased, matching the `email` we query here.
  const { count: pendingForEmail, error: throttleError } = await admin
    .from("agent_claims")
    .select("id", { count: "exact", head: true })
    .eq("flow", "verified_email")
    .eq("status", "pending")
    .eq("email", email)
    .gt("expires_at", new Date().toISOString());
  if (throttleError) throw throttleError;
  if ((pendingForEmail ?? 0) >= serverEnv().AGENT_MAX_PENDING_OTP_PER_EMAIL) {
    throw new AgentRequestError(429, "rate_limited");
  }

  // 6-digit OTP, zero-padded. Store only the hash.
  const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const claimToken = generateClaimToken();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  const { data: claimRow, error: claimError } = await admin
    .from("agent_claims")
    .insert({
      flow: "verified_email",
      claim_token_hash: hashClaimToken(claimToken),
      email,
      otp_hash: hashOtp(otp),
      attempts: 0,
      max_attempts: OTP_MAX_ATTEMPTS,
      post_claim_scopes: postClaimScopes,
      pre_claim_scopes: [],
      client_name: clientName,
      status: "pending",
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (claimError) throw claimError;

  // If the email never sends, the pending row would keep counting against the
  // per-email OTP throttle (and the agent could never receive the code), so
  // delete it on failure before rethrowing.
  try {
    await sendEmail({
      to: email,
      subject: "Your webhooks.cc verification code",
      text: `Your webhooks.cc verification code is ${otp}. It expires in 10 minutes.`,
    });
  } catch (sendError) {
    await admin.from("agent_claims").delete().eq("id", claimRow.id);
    throw sendError;
  }

  return {
    registration_id: claimRow.id,
    registration_type: "email-verification",
    claim_url: claimUrl(),
    claim_token: claimToken,
    claim_token_expires: expiresAt,
    post_claim_scopes: postClaimScopes,
  };
}

export type VerifyOtpResult =
  | {
      ok: true;
      credential: string;
      credential_type: "api_key";
      scopes: string[];
      userId: string;
    }
  | {
      ok: false;
      error:
        | "invalid_claim_token"
        | "claim_expired"
        | "previously_claimed"
        | "otp_expired"
        | "otp_invalid"
        | "too_many_keys";
    };

/**
 * Complete the verified_email flow: validate the OTP, then mint a whcc_ key
 * bound to the matched-or-JIT-provisioned user for the verified email and
 * return the credential (verified_email returns it at completion).
 */
export async function verifyVerifiedEmailOtp(args: {
  claimToken: string;
  otp: string;
}): Promise<VerifyOtpResult> {
  const admin = db();
  const claim = await findClaimByTokenHash(hashClaimToken(args.claimToken));

  if (!claim || claim.flow !== "verified_email" || !claim.email || !claim.otp_hash) {
    return { ok: false, error: "invalid_claim_token" };
  }
  if (claim.status === "claimed") {
    return { ok: false, error: "previously_claimed" };
  }
  if (isExpired(claim.expires_at)) {
    return { ok: false, error: "claim_expired" };
  }
  if (claim.attempts >= claim.max_attempts) {
    // Locked after too many wrong guesses.
    return { ok: false, error: "otp_expired" };
  }

  if (!digestsEqual(hashOtp(args.otp), claim.otp_hash)) {
    // Atomic server-side increment so EVERY wrong guess counts. A compare-and-set
    // bump (`.eq("attempts", claim.attempts)`) loses the CAS under concurrent
    // wrong guesses that read the same value — those losers would return
    // otp_invalid WITHOUT incrementing, letting a client batch parallel guesses
    // to exceed max_attempts. The RPC runs a single `set attempts = attempts + 1
    // ... where status = 'pending'`, so each guess advances the counter and the
    // top-of-function max_attempts lock engages reliably.
    const { error: bumpError } = await admin.rpc("increment_agent_claim_attempts", {
      p_claim_id: claim.id,
    });
    if (bumpError) throw bumpError;
    return { ok: false, error: "otp_invalid" };
  }

  const userId = await resolveOrProvisionUser(claim.email, claim.client_name);

  const { count, error: countError } = await admin
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  if (countError) throw countError;
  if ((count ?? 0) >= MAX_KEYS_PER_USER) {
    return { ok: false, error: "too_many_keys" };
  }

  // Mint the key BEFORE marking the claim claimed, so a key-insert failure
  // leaves the claim `pending` (retryable) rather than `claimed`-but-keyless
  // (which would dead-end the registration with no credential ever issued).
  const rawKey = generateApiKey();
  const { data: keyRow, error: keyError } = await admin
    .from("api_keys")
    .insert({
      user_id: userId,
      key_hash: hashApiKey(rawKey),
      key_prefix: rawKey.slice(0, 12),
      name: claim.client_name ? `Agent (${claim.client_name})` : "Agent (verified email)",
      expires_at: null,
      scopes: claim.post_claim_scopes,
      is_agent_issued: true,
      client_name: claim.client_name,
      claimed_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (keyError) throw keyError;

  // Atomically claim the row and bind the key in one update (guards concurrent
  // OTP completion). If another request claimed it first, drop the orphan key.
  const { data: claimedRow, error: claimUpdateError } = await admin
    .from("agent_claims")
    .update({ status: "claimed", claimed_by_user_id: userId, api_key_id: keyRow.id })
    .eq("id", claim.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (claimUpdateError) throw claimUpdateError;
  if (!claimedRow) {
    await admin.from("api_keys").delete().eq("id", keyRow.id);
    return { ok: false, error: "previously_claimed" };
  }

  return {
    ok: true,
    credential: rawKey,
    credential_type: "api_key",
    scopes: claim.post_claim_scopes,
    userId,
  };
}

// ---------------------------------------------------------------------------
// identity_assertion (ID-JAG) flow
// ---------------------------------------------------------------------------

export interface IdJagCredential {
  credential: string;
  credential_type: "api_key";
  credential_expires: null;
  scopes: string[];
  userId: string;
}

export type IssueIdJagResult =
  | { ok: true; value: IdJagCredential }
  | { ok: false; error: "too_many_keys" };

/**
 * Issue a credential for a verified ID-JAG assertion. Matches an existing user
 * by verified email or JIT-provisions one, then mints a whcc_ key bound to that
 * user with client_name encoding the issuer+sub (for revocation).
 */
export async function issueIdJagCredential(verified: IdJagSuccess): Promise<IssueIdJagResult> {
  const admin = db();
  const scopes = defaultAgentScopes();

  // SECURITY: only a VERIFIED email may resolve or provision an account. A
  // present-but-unverified email (e.g. a phone-verified assertion that also
  // carries an unverified `email` claim) MUST NOT bind to an account by email —
  // otherwise an attacker could assert a victim's address and take over their
  // account. verifyIdJag already strips an unverified email; we re-check the
  // flag explicitly here as defense in depth.
  const email = verified.email;
  if (!email || !verified.emailVerified) {
    throw new AgentRequestError(400, "missing_verified_email");
  }

  const userId = await resolveOrProvisionUser(email, verified.name ?? null);

  const { count, error: countError } = await admin
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  if (countError) throw countError;
  if ((count ?? 0) >= MAX_KEYS_PER_USER) {
    return { ok: false, error: "too_many_keys" };
  }

  const rawKey = generateApiKey();
  const { error: keyError } = await admin.from("api_keys").insert({
    user_id: userId,
    key_hash: hashApiKey(rawKey),
    key_prefix: rawKey.slice(0, 12),
    name: "Agent (identity assertion)",
    expires_at: null,
    scopes,
    is_agent_issued: true,
    // Encode iss+sub so revokeForIssuerSubject() can target this key.
    client_name: encodeIssuerSubject(verified.iss, verified.sub),
    claimed_at: new Date().toISOString(),
  });

  if (keyError) throw keyError;

  return {
    ok: true,
    value: {
      credential: rawKey,
      credential_type: "api_key",
      credential_expires: null,
      scopes,
      userId,
    },
  };
}

/**
 * Convenience wrapper: verify an ID-JAG JWT then issue a credential. Returns the
 * id-jag verification error verbatim, or a too_many_keys credential error.
 */
export async function registerWithIdJag(jwt: string) {
  const verified = await verifyIdJag(jwt);
  if (!verified.ok) {
    return { ok: false as const, error: verified.error };
  }
  const issued = await issueIdJagCredential(verified);
  if (!issued.ok) {
    return { ok: false as const, error: issued.error };
  }
  return { ok: true as const, value: issued.value, verified };
}

// ---------------------------------------------------------------------------
// Revocation (logout+jwt)
// ---------------------------------------------------------------------------

/** Marker stored in api_keys.client_name to tie a key to an (iss,sub). */
function encodeIssuerSubject(iss: string, sub: string): string {
  return `idjag:${iss}#${sub}`;
}

/**
 * Revoke all agent keys issued for a given (iss, sub) identity. Deletes the
 * matching api_keys rows. Used by the provider-initiated logout flow.
 * Returns the number of keys revoked.
 */
export async function revokeForIssuerSubject(iss: string, sub: string): Promise<number> {
  const admin = db();
  const marker = encodeIssuerSubject(iss, sub);

  const { data, error } = await admin
    .from("api_keys")
    .delete()
    .eq("is_agent_issued", true)
    .eq("client_name", marker)
    .select("id");

  if (error) throw error;
  return (data as { id: string }[] | null)?.length ?? 0;
}

// ---------------------------------------------------------------------------
// User resolution / JIT provisioning
// ---------------------------------------------------------------------------

/**
 * Match an existing public.users row by verified email (case-insensitive), else
 * JIT-provision via Supabase Auth (which fires handle_new_user to upsert
 * public.users). The auth user id equals public.users.id.
 */
async function resolveOrProvisionUser(email: string, fullName: string | null): Promise<string> {
  const admin = db();
  const normalized = email.toLowerCase();

  // Exact match (not ilike): `_`/`%` in an email would be treated as LIKE
  // wildcards and could resolve to the WRONG account. Emails are normalized to
  // lowercase here and stored lowercased by Supabase Auth, so eq is correct.
  const { data: existing, error: lookupError } = await admin
    .from("users")
    .select("id")
    .eq("email", normalized)
    .maybeSingle();

  if (lookupError) throw lookupError;
  if (existing) {
    return (existing as { id: string }).id;
  }

  const { data: created, error: createError } = await createAdminClient().auth.admin.createUser({
    email: normalized,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : {},
  });

  if (createError) throw createError;
  if (!created.user) {
    throw new Error("Failed to provision user for agent registration");
  }

  return created.user.id;
}
