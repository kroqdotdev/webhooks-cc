import { extractBearerToken } from "@/lib/api-auth";
import { auditUserAction } from "@/lib/audit";
import { notifyTwoFactorOff, redeemRecoveryCode } from "@/lib/mfa-recovery";
import { reportError } from "@/lib/observability";
import { checkRateLimit, checkRateLimitByKey } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Signing in with a recovery code instead of the authenticator. The caller
 * has a session that passed the password (or link) step but not the second
 * factor, which every other route refuses, so this one validates the token
 * itself. A good code removes the account's authenticators and emails the
 * owner; the person then sets two-factor up again.
 */
export async function POST(request: Request) {
  const token = extractBearerToken(request);
  if (!token || token.startsWith("whcc_")) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  const ipLimited = await checkRateLimit(request, "mfa-recover", 20, 60 * 60_000);
  if (ipLimited) return ipLimited;

  const {
    data: { user },
    error: userError,
  } = await createAdminClient().auth.getUser(token);
  if (userError || !user) return Response.json({ error: "Sign in first." }, { status: 401 });

  const userLimited = await checkRateLimitByKey(`mfa:recover:${user.id}`, 5, 15 * 60_000);
  if (userLimited) return userLimited;

  let code: unknown;
  try {
    code = ((await request.json()) as Record<string, unknown>).code;
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (typeof code !== "string" || code.length > 40) {
    return Response.json({ error: "Enter a recovery code." }, { status: 400 });
  }

  try {
    const used = await redeemRecoveryCode(user.id, code);
    await auditUserAction(request, user.id, {
      action: "account.mfa_recovered",
      status: used ? 200 : 401,
    });
    if (!used) {
      return Response.json(
        { error: "That recovery code is not valid, or was used already." },
        { status: 401 }
      );
    }
    await notifyTwoFactorOff(user.id, "recovery_code");
    return Response.json({ ok: true });
  } catch (error) {
    reportError("[mfa] recovery failed", error);
    return Response.json({ error: "The code could not be checked. Try again." }, { status: 500 });
  }
}
