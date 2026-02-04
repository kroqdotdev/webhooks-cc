import { getConvexClient } from "@/lib/convex-client";
import { checkRateLimit } from "@/lib/rate-limit";
import { api } from "@convex/_generated/api";

export async function POST(request: Request) {
  const rateLimited = checkRateLimit(request, 10);
  if (rateLimited) return rateLimited;

  try {
    const convex = getConvexClient();
    const result = await convex.mutation(api.deviceAuth.createDeviceCode, {});

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://webhooks.cc";

    return Response.json({
      deviceCode: result.deviceCode,
      userCode: result.userCode,
      expiresAt: result.expiresAt,
      verificationUrl: `${appUrl}/cli/verify`,
    });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
