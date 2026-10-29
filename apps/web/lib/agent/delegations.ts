import { serverEnv } from "@/lib/env";
import { isCaptureDomainAddress } from "@/lib/email-capture";
import { isPlainEmailAddress } from "@/lib/request-validation";
import { createAdminClient } from "@/lib/supabase/admin";
import { signAssertion } from "./assertion";
import { accountEmail, newAttemptSecrets, type ClaimAttempt } from "./claims";
import {
  CLAIMED_ASSERTION_TTL_SECONDS,
  MAX_CLAIM_ATTEMPTS,
  UNCLAIMED_LIFETIME_SECONDS,
  USER_CODE_TTL_SECONDS,
} from "./constants";
import { AgentError } from "./errors";
import type { IdJagSuccess } from "./id-jag";
import { generateClaimToken, hashClaimToken, type RegistrationRow } from "./registrations";

/**
 * ID-JAG delegations (auth.md v0.5). An identity_assertion registration is
 * the delegation for one provider identity (iss, sub), resolved in the order
 * the spec gives:
 *
 *   1. A delegation on file: the identity links to its account.
 *   2. An existing account with the assertion's verified email: nothing binds
 *      until the human signed in as that email confirms it through the claim
 *      ceremony (interaction_required). Without this step any trusted
 *      provider could take over an account by asserting its email.
 *   3. No account: one is created for the email, and the identity links to it.
 *
 * link_agent_idjag_identity() (migration 00057) decides under a lock per
 * identity, so concurrent presentations agree.
 */

export type IdJagLink =
  | {
      status: "linked";
      registration: RegistrationRow;
      assertion: string;
      assertionExpires: Date;
      /** True when this presentation created the delegation. */
      created: boolean;
      /** True when this presentation created the account. */
      provisioned: boolean;
    }
  | {
      status: "interaction_required";
      registration: RegistrationRow;
      claimToken: string;
      attempt: ClaimAttempt;
      created: boolean;
    };

async function userIdByEmail(email: string): Promise<string | null> {
  const admin = createAdminClient();
  // Exact match: emails are stored lower-cased, and LIKE would treat `_` and
  // `%` in an address as wildcards.
  const { data, error } = await admin.from("users").select("id").eq("email", email).maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

async function hasLiveDelegation(iss: string, sub: string): Promise<boolean> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("agent_registrations")
    .select("id", { count: "exact", head: true })
    .eq("idjag_iss", iss)
    .eq("idjag_sub", sub)
    .is("revoked_at", null)
    .not("claimed_at", "is", null);
  if (error) throw error;
  return (count ?? 0) > 0;
}

/**
 * Creates an account for the email and returns its id, or null when one
 * turned out to exist (created concurrently): that account gets the
 * ceremony like any other existing one.
 */
async function createAccount(email: string, fullName: string | null): Promise<string | null> {
  const { data, error } = await createAdminClient().auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : {},
  });
  if (error) {
    if (await userIdByEmail(email)) return null;
    throw error;
  }
  if (!data.user) throw new Error("Failed to provision a user for an ID-JAG registration");
  return data.user.id;
}

async function readRegistration(id: string): Promise<RegistrationRow> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("agent_registrations").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

export async function linkIdJagIdentity(verified: IdJagSuccess): Promise<IdJagLink> {
  // Only a verified email may match or create an account; verifyIdJag already
  // drops an unverified one, and this repeats the check.
  if (!verified.email || !verified.emailVerified) {
    throw new AgentError(400, "invalid_request", "The assertion carries no verified email.");
  }
  const email = verified.email.trim().toLowerCase();
  // Mail to the capture domain can be read through webhooks.cc itself, so it
  // never identifies anyone.
  if (
    !isPlainEmailAddress(email) ||
    isCaptureDomainAddress(email, serverEnv().EMAIL_CAPTURE_DOMAIN)
  ) {
    throw new AgentError(400, "invalid_request", "The assertion's email cannot be used here.");
  }

  let provisionedUserId: string | null = null;
  if (!(await hasLiveDelegation(verified.iss, verified.sub)) && !(await userIdByEmail(email))) {
    provisionedUserId = await createAccount(email, verified.name ?? null);
  }

  const claimToken = generateClaimToken();
  const secrets = newAttemptSecrets();
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("link_agent_idjag_identity", {
    p_iss: verified.iss,
    p_sub: verified.sub,
    p_login_hint: email,
    p_jit_user_id: provisionedUserId,
    p_claim_token_hash: hashClaimToken(claimToken),
    p_attempt_token_hash: secrets.attemptTokenHash,
    p_user_code_hash: secrets.userCodeHash,
    p_lifetime_seconds: UNCLAIMED_LIFETIME_SECONDS,
    p_attempt_seconds: USER_CODE_TTL_SECONDS,
    p_max_attempts: MAX_CLAIM_ATTEMPTS,
    p_max_pending: serverEnv().AGENT_MAX_PENDING_PER_LOGIN_HINT,
  });
  if (error) throw error;
  const result = data as {
    status: string;
    registration_id?: string;
    created?: boolean;
    attempt?: number;
    attempt_expires_at?: string;
  };

  switch (result.status) {
    case "linked": {
      const registration = await readRegistration(result.registration_id!);
      const assertionExpires = new Date(Date.now() + CLAIMED_ASSERTION_TTL_SECONDS * 1000);
      const assertion = await signAssertion({
        registrationId: registration.id,
        stage: "claimed",
        expiresAt: assertionExpires,
        email: await accountEmail(registration.user_id!),
      });
      return {
        status: "linked",
        registration,
        assertion,
        assertionExpires,
        created: result.created === true,
        provisioned: provisionedUserId !== null,
      };
    }
    case "pending": {
      const registration = await readRegistration(result.registration_id!);
      return {
        status: "interaction_required",
        registration,
        claimToken,
        created: result.created === true,
        attempt: {
          registrationId: registration.id,
          kind: "identity_assertion",
          attemptToken: secrets.attemptToken,
          attemptTokenHash: secrets.attemptTokenHash,
          userCode: secrets.userCode,
          expiresAt: new Date(result.attempt_expires_at!),
          attempt: result.attempt!,
        },
      };
    }
    case "too_many_attempts":
      throw new AgentError(
        429,
        "too_many_attempts",
        `This identity started ${MAX_CLAIM_ATTEMPTS} confirmations. Wait for the registration to expire.`
      );
    case "too_many_pending":
      throw new AgentError(
        429,
        "rate_limited",
        "Too many agents are waiting for this person already. Retry later.",
        {},
        { "Retry-After": "600" }
      );
    default:
      throw new Error(`Unexpected link_agent_idjag_identity status: ${result.status}`);
  }
}
