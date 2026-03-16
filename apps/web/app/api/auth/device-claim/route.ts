import { checkRateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/request-validation";
import { claimDeviceCode } from "@/lib/supabase/device-auth";
import { sendError } from "@appsignal/nodejs";

export async function POST(request: Request) {
  const rateLimited = checkRateLimit(request, 10);
  if (rateLimited) return rateLimited;

  const parsed = await parseJsonBody(request, 1024);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data as Record<string, unknown>;

  if (typeof body.deviceCode !== "string") {
    return Response.json({ error: "Missing deviceCode" }, { status: 400 });
  }

  try {
    const result = await claimDeviceCode(body.deviceCode);

    return Response.json({
      apiKey: result.apiKey,
      userId: result.userId,
      email: result.email,
    });
  } catch (error) {
    // Distinguish expected claim failures (expired, already used, etc.) from server errors
    if (
      error instanceof Error &&
      (error.message.includes("expired") ||
        error.message.includes("Invalid") ||
        error.message.includes("already claimed") ||
        error.message.includes("not yet authorized") ||
        error.message.includes("not properly authorized") ||
        error.message.includes("Maximum of"))
    ) {
      return Response.json({ error: "Claim failed" }, { status: 400 });
    }
    sendError(error instanceof Error ? error : new Error(String(error)));
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
