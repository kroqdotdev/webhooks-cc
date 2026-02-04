import { authenticateRequest, convexCliRequest } from "@/lib/api-auth";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;

  const { id } = await params;

  return convexCliRequest("/cli/requests", {
    params: { requestId: id, userId: auth.userId },
  });
}
