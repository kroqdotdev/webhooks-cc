import { getConvexClient } from "@/lib/convex-client";
import { checkRateLimit } from "@/lib/rate-limit";
import { api } from "@convex/_generated/api";

export async function POST(request: Request) {
  const rateLimited = checkRateLimit(request, 10);
  if (rateLimited) return rateLimited;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.deviceCode !== "string") {
    return Response.json({ error: "Missing deviceCode" }, { status: 400 });
  }

  try {
    const convex = getConvexClient();
    const result = await convex.mutation(api.deviceAuth.claimDeviceCode, {
      deviceCode: body.deviceCode,
    });

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
        error.message.includes("not yet authorized") ||
        error.message.includes("not properly authorized") ||
        error.message.includes("Maximum of"))
    ) {
      return Response.json({ error: "Claim failed" }, { status: 400 });
    }
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
