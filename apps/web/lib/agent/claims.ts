import { createHash, randomInt } from "node:crypto";
import { customAlphabet } from "nanoid";
import { publicEnv, serverEnv } from "@/lib/env";
import { isCaptureDomainAddress } from "@/lib/email-capture";
import { isPlainEmailAddress } from "@/lib/request-validation";
import { createAdminClient } from "@/lib/supabase/admin";
import { signAssertion } from "./assertion";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CLAIM_POLL_INTERVAL_SECONDS,
  CLAIMED_ASSERTION_TTL_SECONDS,
  MAX_CLAIM_ATTEMPTS,
  MAX_CODE_FAILURES,
  MAX_CONNECTED_AGENTS,
  POST_CLAIM_SCOPES,
  UNCLAIMED_LIFETIME_SECONDS,
  USER_CODE_TTL_SECONDS,
} from "./constants";
import { AgentError } from "./errors";
import { providerDisplayName } from "./trusted-providers";
import {
  generateClaimToken,
  hashClaimToken,
  mintAccessToken,
  type AccessToken,
  type RegistrationRow,
} from "./registrations";

/**
 * The claim ceremony (auth.md v0.6, Step 4). The agent starts an attempt and
 * shows the human a link and a 6-digit code; the human signs in, opens the
 * link and types the code; the agent polls the claim grant with its claim
 * token. Three secrets, three jobs: the attempt token in the link (about 190
 * bits) says which registration, the code proves the human is looking at the
 * agent, and the email the agent named decides who may complete it.
 */

const generateAttemptBody = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  32
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateAttemptToken(): string {
  return `cat_${generateAttemptBody()}`;
}

export function hashAttemptToken(token: string): string {
  return sha256(token);
}

export function generateUserCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** The code as typed: spaces and dashes are fine; anything but 6 digits is not. */
export function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 32) return null;
  const digits = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** Bound to its attempt, so a leaked hash is useless for another attempt. */
export function hashUserCode(attemptTokenHash: string, code: string): string {
  return sha256(`${attemptTokenHash}:${code}`);
}

export function verificationUri(attemptToken: string): string {
  return `${publicEnv().NEXT_PUBLIC_APP_URL}/agent/claim?attempt=${attemptToken}`;
}

export function claimAttemptId(attemptTokenHash: string): string {
  return `cla_${attemptTokenHash.slice(0, 24)}`;
}

/**
 * The email an agent names for its human. Lower-cased; one plain address;
 * never the capture domain, whose mail can be read through webhooks.cc.
 */
export function normalizeLoginHint(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email || !isPlainEmailAddress(email)) {
    throw new AgentError(400, "invalid_login_hint", "Give the human's email address.");
  }
  if (isCaptureDomainAddress(email, serverEnv().EMAIL_CAPTURE_DOMAIN)) {
    throw new AgentError(
      400,
      "invalid_login_hint",
      `Addresses at ${serverEnv().EMAIL_CAPTURE_DOMAIN} cannot own an account.`
    );
  }
  return email;
}

/** `jane@example.com` becomes `j***@example.com`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export interface ClaimAttempt {
  registrationId: string;
  kind: RegistrationRow["kind"];
  attemptToken: string;
  attemptTokenHash: string;
  userCode: string;
  expiresAt: Date;
  attempt: number;
}

/** The RFC 8628-shaped block an agent hands to its human. */
export function claimAttemptBlock(attempt: ClaimAttempt) {
  return {
    user_code: attempt.userCode,
    expires_in: Math.max(1, Math.floor((attempt.expiresAt.getTime() - Date.now()) / 1000)),
    verification_uri: verificationUri(attempt.attemptToken),
    interval: CLAIM_POLL_INTERVAL_SECONDS,
  };
}

export function newAttemptSecrets() {
  const attemptToken = generateAttemptToken();
  const attemptTokenHash = hashAttemptToken(attemptToken);
  const userCode = generateUserCode();
  return {
    attemptToken,
    attemptTokenHash,
    userCode,
    userCodeHash: hashUserCode(attemptTokenHash, userCode),
  };
}

/**
 * Starts an attempt for the registration behind a claim token, replacing
 * any earlier one. `loginHint` is required for anonymous registrations;
 * service_auth registrations keep the email they registered with.
 */
export async function startClaimAttempt(input: {
  claimToken: string;
  loginHint: string | null;
}): Promise<ClaimAttempt> {
  const secrets = newAttemptSecrets();
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("start_agent_claim_attempt", {
    p_claim_token_hash: hashClaimToken(input.claimToken),
    p_attempt_token_hash: secrets.attemptTokenHash,
    p_user_code_hash: secrets.userCodeHash,
    p_login_hint: input.loginHint,
    p_attempt_seconds: USER_CODE_TTL_SECONDS,
    p_max_attempts: MAX_CLAIM_ATTEMPTS,
  });
  if (error) throw error;
  const result = data as {
    status: string;
    registration_id?: string;
    kind?: RegistrationRow["kind"];
    attempt?: number;
    attempt_expires_at?: string;
  };

  switch (result.status) {
    case "ok":
      return {
        registrationId: result.registration_id!,
        kind: result.kind!,
        attemptToken: secrets.attemptToken,
        attemptTokenHash: secrets.attemptTokenHash,
        userCode: secrets.userCode,
        expiresAt: new Date(result.attempt_expires_at!),
        attempt: result.attempt!,
      };
    case "invalid_claim_token":
      throw new AgentError(401, "invalid_claim_token", "Unknown or revoked claim token.");
    case "claimed_or_in_flight":
      throw new AgentError(
        409,
        "claimed_or_in_flight",
        "This registration is already claimed. Poll the claim grant to collect it."
      );
    case "claim_expired":
      throw new AgentError(410, "claim_expired", "The registration expired. Register again.");
    case "too_many_attempts":
      throw new AgentError(
        429,
        "too_many_attempts",
        `A registration may start ${MAX_CLAIM_ATTEMPTS} claim attempts. Register again.`
      );
    case "login_hint_required":
      throw new AgentError(400, "invalid_request", "Give the human's email as `email`.");
    case "login_hint_mismatch":
      throw new AgentError(
        400,
        "invalid_login_hint",
        "This registration is bound to the email it registered with."
      );
    default:
      throw new Error(`Unexpected start_agent_claim_attempt status: ${result.status}`);
  }
}

/**
 * A service_auth registration: no sandbox and no assertion until a signed-in
 * human with that email completes the attempt it starts with. Nothing is
 * emailed.
 */
export async function createServiceAuthRegistration(input: {
  loginHint: string;
  clientName: string | null;
}): Promise<{ registration: RegistrationRow; claimToken: string; attempt: ClaimAttempt }> {
  const admin = createAdminClient();
  const { count, error: countError } = await admin
    .from("agent_registrations")
    .select("id", { count: "exact", head: true })
    .eq("kind", "service_auth")
    .eq("attempt_login_hint", input.loginHint)
    .is("claimed_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString());
  if (countError) throw countError;
  if ((count ?? 0) >= serverEnv().AGENT_MAX_PENDING_PER_LOGIN_HINT) {
    throw new AgentError(
      429,
      "rate_limited",
      "Too many agents are waiting for this person already. Retry later.",
      {},
      { "Retry-After": "600" }
    );
  }

  const claimToken = generateClaimToken();
  const secrets = newAttemptSecrets();
  const now = Date.now();
  const expiresAt = new Date(now + UNCLAIMED_LIFETIME_SECONDS * 1000);
  const attemptExpires = new Date(now + USER_CODE_TTL_SECONDS * 1000);
  const { data, error } = await admin
    .from("agent_registrations")
    .insert({
      kind: "service_auth",
      client_name: input.clientName,
      claim_token_hash: hashClaimToken(claimToken),
      expires_at: expiresAt.toISOString(),
      attempt_token_hash: secrets.attemptTokenHash,
      attempt_user_code_hash: secrets.userCodeHash,
      attempt_login_hint: input.loginHint,
      attempt_expires_at: attemptExpires.toISOString(),
      attempts_issued: 1,
    })
    .select("*")
    .single();
  if (error) throw error;

  return {
    registration: data,
    claimToken,
    attempt: {
      registrationId: data.id,
      kind: "service_auth",
      attemptToken: secrets.attemptToken,
      attemptTokenHash: secrets.attemptTokenHash,
      userCode: secrets.userCode,
      expiresAt: attemptExpires,
      attempt: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// The human's side: the claim page
// ---------------------------------------------------------------------------

export async function accountEmail(userId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("users").select("email").eq("id", userId).maybeSingle();
  if (error) throw error;
  return data?.email?.toLowerCase() ?? null;
}

export type AttemptState = "pending" | "expired" | "denied" | "locked";

export interface AttemptView {
  state: AttemptState;
  clientName: string | null;
  kind: RegistrationRow["kind"];
  /** For an ID-JAG identity: its provider, named by our trust list. */
  provider: string | null;
  registeredAt: number;
  attemptExpiresAt: number | null;
  requestedFor: string;
  signedInAs: string | null;
  emailMatches: boolean;
  codesLeft: number;
  firstAgent: boolean;
  endpoints: { slug: string; requestCount: number }[];
}

/**
 * What the claim page shows. Null when the link is unknown, replaced by a
 * newer attempt, or already used. Nothing from the URL is echoed.
 */
export async function readClaimAttempt(
  attemptToken: string,
  user: { id: string; email: string | null }
): Promise<AttemptView | null> {
  if (!/^cat_[A-Za-z0-9]{32}$/.test(attemptToken)) return null;
  const admin = createAdminClient();
  const { data: registration, error } = await admin
    .from("agent_registrations")
    .select("*")
    .eq("attempt_token_hash", hashAttemptToken(attemptToken))
    .maybeSingle();
  if (error) throw error;
  if (!registration || registration.revoked_at || registration.claimed_at) return null;

  const now = Date.now();
  const attemptExpires = registration.attempt_expires_at
    ? Date.parse(registration.attempt_expires_at)
    : null;
  const state: AttemptState =
    Date.parse(registration.expires_at) <= now || !attemptExpires || attemptExpires <= now
      ? "expired"
      : registration.attempt_denied_at
        ? "denied"
        : registration.attempt_failures >= MAX_CODE_FAILURES
          ? "locked"
          : "pending";

  const [{ data: endpoints, error: endpointsError }, { count: ever, error: everError }] =
    await Promise.all([
      admin
        .from("endpoints")
        .select("slug, request_count")
        .eq("agent_registration_id", registration.id)
        .gt("expires_at", new Date(now).toISOString())
        .order("created_at"),
      admin
        .from("agent_registrations")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .not("claimed_at", "is", null),
    ]);
  if (endpointsError) throw endpointsError;
  if (everError) throw everError;

  const hint = registration.attempt_login_hint ?? "";
  return {
    state,
    clientName: registration.client_name,
    kind: registration.kind,
    provider:
      registration.kind === "identity_assertion" && registration.idjag_iss
        ? providerDisplayName(registration.idjag_iss)
        : null,
    registeredAt: Date.parse(registration.created_at),
    attemptExpiresAt: attemptExpires,
    requestedFor: maskEmail(hint),
    signedInAs: user.email,
    emailMatches: Boolean(user.email) && user.email === hint,
    codesLeft: Math.max(0, MAX_CODE_FAILURES - registration.attempt_failures),
    firstAgent: (ever ?? 0) === 0,
    endpoints: (endpoints ?? []).map((row) => ({
      slug: row.slug,
      requestCount: row.request_count,
    })),
  };
}

export type CompleteResult =
  | {
      status: "ok";
      registrationId: string;
      clientName: string | null;
      kind: RegistrationRow["kind"];
      adopted: string[];
      firstAgent: boolean;
    }
  | { status: "wrong_code"; registrationId: string; remaining: number }
  | {
      status:
        | "invalid"
        | "already_claimed"
        | "expired"
        | "denied"
        | "locked"
        | "wrong_account"
        | "too_many_agents";
      registrationId?: string;
    };

export async function completeClaim(input: {
  attemptToken: string;
  userCode: string;
  userId: string;
  email: string | null;
}): Promise<CompleteResult> {
  const attemptTokenHash = hashAttemptToken(input.attemptToken);
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("complete_agent_claim", {
    p_attempt_token_hash: attemptTokenHash,
    p_user_code_hash: hashUserCode(attemptTokenHash, input.userCode),
    p_user_id: input.userId,
    p_user_email: input.email ?? "",
    p_max_agents: MAX_CONNECTED_AGENTS,
    p_max_failures: MAX_CODE_FAILURES,
  });
  if (error) throw error;
  const result = data as {
    status: string;
    registration_id?: string;
    client_name?: string | null;
    kind?: RegistrationRow["kind"];
    adopted?: string[];
    first_agent?: boolean;
    remaining?: number;
  };
  if (result.status === "ok") {
    return {
      status: "ok",
      registrationId: result.registration_id!,
      clientName: result.client_name ?? null,
      kind: result.kind!,
      adopted: result.adopted ?? [],
      firstAgent: result.first_agent ?? false,
    };
  }
  if (result.status === "wrong_code") {
    return {
      status: "wrong_code",
      registrationId: result.registration_id!,
      remaining: result.remaining ?? 0,
    };
  }
  return {
    status: result.status as Exclude<CompleteResult["status"], "ok" | "wrong_code">,
    registrationId: result.registration_id,
  };
}

export async function denyClaim(input: {
  attemptToken: string;
  email: string | null;
}): Promise<{ status: "ok" | "invalid" | "wrong_account"; registrationId?: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("deny_agent_claim_attempt", {
    p_attempt_token_hash: hashAttemptToken(input.attemptToken),
    p_user_email: input.email ?? "",
  });
  if (error) throw error;
  const result = data as { status: "ok" | "invalid" | "wrong_account"; registration_id?: string };
  return { status: result.status, registrationId: result.registration_id };
}

// ---------------------------------------------------------------------------
// The agent's side: the claim grant
// ---------------------------------------------------------------------------

export type PollResult =
  | { status: "pending" | "expired" | "denied" }
  | { status: "invalid"; description: string }
  | {
      status: "claimed";
      token: AccessToken;
      assertion: string;
      assertionExpires: Date;
      registration: RegistrationRow;
    };

/**
 * One poll of the claim grant. After a claim, the first poll collects the
 * account credentials and uses the claim token up; a lost response means
 * registering again.
 */
export async function pollClaim(claimToken: string): Promise<PollResult> {
  const admin = createAdminClient();
  const { data: registration, error } = await admin
    .from("agent_registrations")
    .select("*")
    .eq("claim_token_hash", hashClaimToken(claimToken))
    .maybeSingle();
  if (error) throw error;
  if (!registration || registration.revoked_at) {
    return { status: "invalid", description: "Unknown or revoked claim token." };
  }
  if (registration.claim_consumed_at) {
    return { status: "invalid", description: "This claim was already collected." };
  }

  if (registration.claimed_at && registration.user_id) {
    const { data: consumed, error: consumeError } = await admin
      .from("agent_registrations")
      .update({ claim_consumed_at: new Date().toISOString() })
      .eq("id", registration.id)
      .is("claim_consumed_at", null)
      .select("id")
      .maybeSingle();
    if (consumeError) throw consumeError;
    if (!consumed) return { status: "invalid", description: "This claim was already collected." };

    const now = Date.now();
    const token = await mintAccessToken(registration, {
      userId: registration.user_id,
      scopes: POST_CLAIM_SCOPES,
      expiresAtMs: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
    });
    const assertionExpires = new Date(now + CLAIMED_ASSERTION_TTL_SECONDS * 1000);
    const assertion = await signAssertion({
      registrationId: registration.id,
      stage: "claimed",
      expiresAt: assertionExpires,
      email: await accountEmail(registration.user_id),
    });
    return { status: "claimed", token, assertion, assertionExpires, registration };
  }

  const now = Date.now();
  if (Date.parse(registration.expires_at) <= now) return { status: "expired" };
  if (registration.attempt_denied_at) return { status: "denied" };
  if (
    !registration.attempt_expires_at ||
    Date.parse(registration.attempt_expires_at) <= now ||
    registration.attempt_failures >= MAX_CODE_FAILURES
  ) {
    return { status: "expired" };
  }
  return { status: "pending" };
}

// ---------------------------------------------------------------------------
// Connected agents (Account)
// ---------------------------------------------------------------------------

export interface ConnectedAgent {
  id: string;
  clientName: string | null;
  kind: RegistrationRow["kind"];
  connectedAt: number;
  lastUsedAt: number | null;
}

export async function listConnectedAgents(userId: string): Promise<ConnectedAgent[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_registrations")
    .select("id, client_name, kind, claimed_at")
    .eq("user_id", userId)
    .not("claimed_at", "is", null)
    .is("revoked_at", null)
    .order("claimed_at", { ascending: false });
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const { data: tokens, error: tokenError } = await admin
    .from("api_keys")
    .select("agent_registration_id, last_used_at")
    .in(
      "agent_registration_id",
      rows.map((row) => row.id)
    )
    .not("last_used_at", "is", null);
  if (tokenError) throw tokenError;
  const lastUsed = new Map<string, number>();
  for (const token of tokens ?? []) {
    const at = Date.parse(token.last_used_at!);
    const id = token.agent_registration_id!;
    if (!lastUsed.has(id) || at > lastUsed.get(id)!) lastUsed.set(id, at);
  }

  return rows.map((row) => ({
    id: row.id,
    clientName: row.client_name,
    kind: row.kind,
    connectedAt: Date.parse(row.claimed_at!),
    lastUsedAt: lastUsed.get(row.id) ?? null,
  }));
}

/** Disconnects an agent: its tokens stop working at once. */
export async function revokeConnectedAgent(
  userId: string,
  registrationId: string
): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("revoke_agent_registration", {
    p_id: registrationId,
    p_user_id: userId,
  });
  if (error) throw error;
  return data === true;
}
