import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability";
import { hasVerifiedFactor, jwtClaims, sessionAal } from "@/lib/mfa";

/**
 * Whether a session counts as having passed the second factor: aal2 from
 * GoTrue, or a session a site switch carried the factor to (migration
 * 00088). GoTrue cannot raise a session to aal2 from the server, so a switch
 * between webhooks.cc and mailhooks.cc lists the new session's id in
 * mfa_trusted_sessions when the session it started from had passed it.
 * Server only; the token must already be validated (getUser).
 */

function sessionIdOf(token: string): string | null {
  const id = jwtClaims(token)?.session_id;
  return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export async function isTrustedSession(token: string, userId: string): Promise<boolean> {
  const sessionId = sessionIdOf(token);
  if (!sessionId) return false;
  const { data, error } = await createAdminClient()
    .from("mfa_trusted_sessions")
    .select("session_id")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    // A database without migration 00088 has no carried sessions.
    if (!/mfa_trusted_sessions/.test(error.message)) {
      reportError("[mfa] trusted session lookup failed", error.message);
    }
    return false;
  }
  return data !== null;
}

/** The session passed the second factor, here or before a site switch. */
export async function passedSecondFactor(user: { id: string }, token: string): Promise<boolean> {
  if (sessionAal(token) === "aal2") return true;
  return isTrustedSession(token, user.id);
}

/** The account has an authenticator and this session has not passed it. */
export async function owesSecondFactor(
  user: { id: string; factors?: { status?: string }[] | null },
  token: string
): Promise<boolean> {
  if (!hasVerifiedFactor(user)) return false;
  return !(await passedSecondFactor(user, token));
}

/** Lists a session made by a site switch as having passed the second factor. */
export async function trustSession(token: string, userId: string): Promise<void> {
  const sessionId = sessionIdOf(token);
  if (!sessionId) return;
  const { error } = await createAdminClient()
    .from("mfa_trusted_sessions")
    .upsert({ session_id: sessionId, user_id: userId }, { onConflict: "session_id" });
  if (error) reportError("[mfa] carrying the second factor across a switch failed", error.message);
}
