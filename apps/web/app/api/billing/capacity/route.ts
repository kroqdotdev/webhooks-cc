import { authenticateSessionRequest } from "@/lib/api-auth";
import { handleCapacityGet, handleCapacityPost } from "@/lib/capacity-route";

/** Extra request capacity for the signed-in user's own account (lib/capacity-route.ts). */
export async function GET(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  return handleCapacityGet({ kind: "user", userId: auth.userId }, request);
}

export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  return handleCapacityPost(request, { kind: "user", userId: auth.userId }, auth.userId);
}
