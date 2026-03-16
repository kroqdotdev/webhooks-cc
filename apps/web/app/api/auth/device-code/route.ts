import { checkRateLimit } from "@/lib/rate-limit";
import { createDeviceCodeRecord } from "@/lib/supabase/device-auth";
import { sendError } from "@appsignal/nodejs";

export async function POST(request: Request) {
  const rateLimited = checkRateLimit(request, 10);
  if (rateLimited) return rateLimited;

  try {
    const result = await createDeviceCodeRecord();

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://webhooks.cc";

    return Response.json({
      deviceCode: result.deviceCode,
      userCode: result.userCode,
      expiresAt: result.expiresAt,
      verificationUrl: `${appUrl}/cli/verify`,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Too many pending device codes")) {
      return Response.json({ error: err.message }, { status: 429 });
    }
    sendError(err instanceof Error ? err : new Error(String(err)));
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
