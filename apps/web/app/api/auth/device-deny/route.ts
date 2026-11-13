import { checkRateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/request-validation";
import { createClient } from "@/lib/supabase/server";
import { denyDeviceCode } from "@/lib/supabase/device-auth";
import { reportError } from "@/lib/observability";

/**
 * POST /api/auth/device-deny { userCode }: "This wasn't me". The login ends
 * at once (its next poll answers denied) rather than waiting to expire.
 */
export async function POST(request: Request) {
  const rateLimited = await checkRateLimit(request, "device-authorize", 10);
  if (rateLimited) return rateLimited;

  const parsed = await parseJsonBody(request, 1024);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data as Record<string, unknown>;
  if (typeof body.userCode !== "string") {
    return Response.json({ error: "Missing userCode" }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    await denyDeviceCode(body.userCode);
    return Response.json({ denied: true });
  } catch (error) {
    if (
      error instanceof Error &&
      ["Invalid code", "Code expired", "Code already used"].includes(error.message)
    ) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    reportError("POST /api/auth/device-deny failed", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
