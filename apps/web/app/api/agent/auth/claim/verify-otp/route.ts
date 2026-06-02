import { checkRateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/request-validation";
import { verifyVerifiedEmailOtp } from "@/lib/agent/agent-auth";
import { sendError } from "@appsignal/nodejs";

/**
 * verified_email OTP completion (auth.md). Unauthenticated: the agent submits
 * the 6-digit OTP it received by email along with its claim_token. On success
 * the credential is minted and returned HERE (withheld until OTP confirmation),
 * bound to the matched-or-JIT-provisioned user for the verified email.
 */
export async function POST(request: Request) {
  const rateLimited = await checkRateLimit(request, 10);
  if (rateLimited) return rateLimited;

  const parsed = await parseJsonBody(request, 1024);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data as Record<string, unknown>;

  if (typeof body.claim_token !== "string" || typeof body.otp !== "string") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const registrationId = typeof body.registration_id === "string" ? body.registration_id : undefined;

  try {
    const result = await verifyVerifiedEmailOtp({
      claimToken: body.claim_token,
      otp: body.otp,
    });

    if (result.ok) {
      return Response.json({
        registration_id: registrationId,
        status: "claimed",
        credential_type: "api_key",
        credential: result.credential,
        credential_expires: null,
        scopes: result.scopes,
      });
    }

    switch (result.error) {
      case "otp_invalid":
        return Response.json({ error: "otp_invalid" }, { status: 401 });
      case "otp_expired":
        return Response.json({ error: "otp_expired" }, { status: 410 });
      case "previously_claimed":
        return Response.json({ error: "previously_claimed" }, { status: 409 });
      case "claim_expired":
        return Response.json({ error: "claim_expired" }, { status: 410 });
      case "invalid_claim_token":
        return Response.json({ error: "invalid_claim_token" }, { status: 400 });
      case "too_many_keys":
        return Response.json({ error: "too_many_keys" }, { status: 429 });
      default:
        // Exhaustive over VerifyOtpResult["error"]; guard any future variant so
        // the handler never falls through without a response.
        return Response.json({ error: "internal_error" }, { status: 500 });
    }
  } catch (err) {
    sendError(err instanceof Error ? err : new Error(String(err)));
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
