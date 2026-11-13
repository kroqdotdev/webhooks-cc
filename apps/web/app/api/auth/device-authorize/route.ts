import { checkRateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/request-validation";
import { deviceApprover } from "@/lib/device-session";
import { authorizeDeviceCodeForUser } from "@/lib/supabase/device-auth";
import { reportError } from "@/lib/observability";

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
    // The key this mints reads everything, so a session that skipped the
    // account's authenticator code cannot approve a device.
    const approver = await deviceApprover();
    if ("error" in approver) return approver.error;

    const result = await authorizeDeviceCodeForUser(approver.userId, body.userCode);
    return Response.json(result);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("Invalid code") ||
        error.message.includes("Code expired") ||
        error.message.includes("Code already used"))
    ) {
      return Response.json({ error: error.message }, { status: 400 });
    }

    reportError("POST /api/auth/device-authorize failed", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
