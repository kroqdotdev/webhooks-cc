import { authenticateRequest, convexCliRequest, formatRequest } from "@/lib/api-auth";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { id } = await params;

  const resp = await convexCliRequest("/cli/requests", {
    params: { requestId: id, userId: auth.userId },
  });

  if (!resp.ok) return resp;

  const data = (await resp.json()) as Record<string, unknown>;
  return Response.json(formatRequest(data));
}
