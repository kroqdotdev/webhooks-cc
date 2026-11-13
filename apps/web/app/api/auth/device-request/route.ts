import { checkRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
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
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

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
