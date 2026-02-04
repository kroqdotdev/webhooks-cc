import { getConvexClient } from "@/lib/convex-client";
import { checkRateLimit } from "@/lib/rate-limit";
import { api } from "@convex/_generated/api";

export async function GET(request: Request) {
  const rateLimited = checkRateLimit(request, 30);
  if (rateLimited) return rateLimited;

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  if (!code) {
    return Response.json({ error: "Missing code parameter" }, { status: 400 });
  }

  try {
    const convex = getConvexClient();
    const result = await convex.query(api.deviceAuth.pollDeviceCode, {
      deviceCode: code,
    });

    // Only return the status field to unauthenticated callers
    return Response.json({ status: result.status });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
