import { createHash, randomInt, timingSafeEqual } from "node:crypto";
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
import { isCaptureDomainAddress } from "@/lib/email-capture";
import { generateClaimToken, hashClaimToken } from "./registrations";

/**
 * The auth.md v0.1 verified_email flow (POST /api/agent/auth with
 * type=verified_email, then /api/agent/auth/claim/verify-otp). It is the only
 * v0.1 path left: it needs a human to read an emailed code, so it never
 * touches the sandbox, and it keeps old clients working until its sunset.
 * The rest of agent registration lives in registrations.ts.
 *
 * agent_claims is accessed through an untyped admin client; RLS blocks all
 * non-service access.
 */

const OTP_TTL_MS = 10 * 60 * 1000; // verified_email OTP window
const OTP_MAX_ATTEMPTS = 5;

/**
 * A client-facing error from the verified_email flow that maps to a specific
 * HTTP status + auth.md error code (429 rate_limited, 400 invalid_email).
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

/** Untyped admin client for agent_claims. */
function db(): SupabaseClient {
  return createAdminClient() as unknown as SupabaseClient;
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

function claimUrl(): string {
  return `${publicEnv().NEXT_PUBLIC_APP_URL}/agent/claim`;
}

function isExpired(timestamp: string): boolean {
  return new Date(timestamp).getTime() < Date.now();
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

async function findClaimByTokenHash(tokenHash: string): Promise<AgentClaimRow | null> {
  const { data, error } = await db()
    .from("agent_claims")
    .select(CLAIM_COLUMNS)
    .eq("claim_token_hash", tokenHash)
    .maybeSingle();

  if (error) throw error;
  return (data as AgentClaimRow | null) ?? null;
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
    // wrong guesses that read the same value; those losers would return
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
    .eq("user_id", userId)
    .is("agent_registration_id", null);

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
// User resolution / JIT provisioning
// ---------------------------------------------------------------------------

/**
 * Match an existing public.users row by verified email (case-insensitive), else
 * JIT-provision via Supabase Auth (which fires handle_new_user to upsert
 * public.users). The auth user id equals public.users.id.
 */
export async function resolveOrProvisionUser(
  email: string,
  fullName: string | null
): Promise<string> {
  // Mail to the capture domain can be read through webhooks.cc itself, so it
  // never identifies anyone: no flow may create or reach an account by it.
  if (isCaptureDomainAddress(email, serverEnv().EMAIL_CAPTURE_DOMAIN)) {
    throw new AgentRequestError(400, "invalid_email");
  }
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
