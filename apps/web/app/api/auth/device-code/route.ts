import { ConvexHttpClient } from "convex/browser";
import { api } from "@convex/_generated/api";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export async function POST() {
  const result = await convex.mutation(api.deviceAuth.createDeviceCode, {});

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://webhooks.cc";

  return Response.json({
    deviceCode: result.deviceCode,
    userCode: result.userCode,
    expiresAt: result.expiresAt,
    verificationUrl: `${appUrl}/cli/verify`,
  });
}
