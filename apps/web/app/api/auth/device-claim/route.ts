import { ConvexHttpClient } from "convex/browser";
import { api } from "@convex/_generated/api";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export async function POST(request: Request) {
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
    const result = await convex.mutation(api.deviceAuth.claimDeviceCode, {
      deviceCode: body.deviceCode,
    });

    return Response.json({
      apiKey: result.apiKey,
      userId: result.userId,
      email: result.email,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Claim failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
