import { authenticateSessionRequest, extractBearerToken } from "@/lib/api-auth";
import { auditUserAction } from "@/lib/audit";
import { hasVerifiedFactor } from "@/lib/mfa";
import { passedSecondFactor } from "@/lib/mfa-session";
import { remainingRecoveryCodes, replaceRecoveryCodes } from "@/lib/mfa-recovery";
import { reportError } from "@/lib/observability";
import { checkRateLimitByKey } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

const NO_STORE = { "Cache-Control": "no-store" };

/** How many unused recovery codes the account has. */
export async function GET(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  try {
    return Response.json(
      { remaining: await remainingRecoveryCodes(auth.userId) },
      { headers: NO_STORE }
    );
  } catch (error) {
    reportError("[mfa] counting recovery codes failed", error);
    return Response.json({ error: "Recovery codes could not be read." }, { status: 500 });
  }
}

/**
 * Ten new recovery codes, replacing any earlier ones. Only for a session
 * that signed in with the authenticator code, so a stolen password cannot
 * make codes that skip the authenticator.
 */
export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  const limited = await checkRateLimitByKey(`mfa:codes:${auth.userId}`, 10, 60 * 60_000);
  if (limited) return limited;
  try {
    const token = extractBearerToken(request)!;
    const {
      data: { user },
    } = await createAdminClient().auth.getUser(token);
    if (!user || !hasVerifiedFactor(user) || !(await passedSecondFactor(user, token))) {
      return Response.json(
        { error: "Turn on two-factor sign-in first, then make recovery codes." },
        { status: 409 }
      );
    }
    const codes = await replaceRecoveryCodes(auth.userId);
    await auditUserAction(request, auth.userId, {
      action: "account.recovery_codes_created",
      status: 201,
    });
    return Response.json({ codes }, { status: 201, headers: NO_STORE });
  } catch (error) {
    reportError("[mfa] making recovery codes failed", error);
    return Response.json({ error: "Recovery codes could not be made." }, { status: 500 });
  }
}
