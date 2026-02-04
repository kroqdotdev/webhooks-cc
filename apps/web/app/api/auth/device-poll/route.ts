import { ConvexHttpClient } from "convex/browser";
import { api } from "@convex/_generated/api";
import { NextRequest } from "next/server";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return Response.json({ error: "Missing code parameter" }, { status: 400 });
  }

  const result = await convex.query(api.deviceAuth.pollDeviceCode, {
    deviceCode: code,
  });

  return Response.json(result);
}
