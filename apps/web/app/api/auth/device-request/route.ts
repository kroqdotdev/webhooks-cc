import { checkRateLimit } from "@/lib/rate-limit";
import { deviceApprover } from "@/lib/device-session";
import { describeDeviceCode } from "@/lib/supabase/device-auth";
import { networkOf } from "@/lib/device-requester";
import { reportError } from "@/lib/observability";

/**
 * GET /api/auth/device-request?code=XXXX-XXXX: what the approval page shows
 * about a pending device login (the client, where it asked from, whether the
 * browser is on the same network). Signed-in browsers only.
 */
export async function GET(request: Request) {
  const rateLimited = await checkRateLimit(request, "device-request", 30);
  if (rateLimited) return rateLimited;

  const code = new URL(request.url).searchParams.get("code");
  if (!code || code.length > 16) {
    return Response.json({ error: "Missing code parameter" }, { status: 400 });
  }

  try {
    const approver = await deviceApprover();
    if ("error" in approver) return approver.error;

    const login = await describeDeviceCode(code, networkOf(request));
    if (!login) {
      return Response.json(
        { error: "This code has expired or was already used." },
        { status: 404 }
      );
    }
    return Response.json(login);
  } catch (error) {
    reportError("GET /api/auth/device-request failed", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
