import { checkRateLimit } from "@/lib/rate-limit";
import { pollDeviceCodeStatus } from "@/lib/supabase/device-auth";
import { reportError } from "@/lib/observability";

export async function GET(request: Request) {
  const rateLimited = await checkRateLimit(request, "device-poll", 30);
  if (rateLimited) return rateLimited;

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  if (!code) {
    return Response.json({ error: "Missing code parameter" }, { status: 400 });
  }

  try {
    const result = await pollDeviceCodeStatus(code);

    // Only return the status field to unauthenticated callers
    return Response.json({ status: result.status });
  } catch (err) {
    reportError("GET /api/auth/device-poll failed", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
