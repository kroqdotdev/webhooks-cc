import { checkRateLimit } from "@/lib/rate-limit";
import { createDeviceCodeRecord } from "@/lib/supabase/device-auth";
import { deviceRequester } from "@/lib/device-requester";
import { reportError } from "@/lib/observability";

/** The optional body: what the client is and whether it runs on another machine. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = (await request.text()).slice(0, 2048);
    const data: unknown = text.trim() ? JSON.parse(text) : {};
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    // Older clients send `{}` or nothing; a body that is not JSON only
    // loses the details, never the login.
    return {};
  }
}

export async function POST(request: Request) {
  const rateLimited = await checkRateLimit(request, "device-code", 10);
  if (rateLimited) return rateLimited;

  try {
    const result = await createDeviceCodeRecord(deviceRequester(request, await readBody(request)));

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://webhooks.cc";
    const verificationUrl = `${appUrl}/cli/verify`;

    return Response.json({
      deviceCode: result.deviceCode,
      userCode: result.userCode,
      expiresAt: result.expiresAt,
      verificationUrl,
      // RFC 8628's verification_uri_complete: the page opens with the code,
      // and the person compares it with the terminal instead of typing it.
      verificationUrlComplete: `${verificationUrl}?code=${encodeURIComponent(result.userCode)}`,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Too many pending device codes")) {
      return Response.json({ error: err.message }, { status: 429 });
    }
    reportError("POST /api/auth/device-code failed", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
