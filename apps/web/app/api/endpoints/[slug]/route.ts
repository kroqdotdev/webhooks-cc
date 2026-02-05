import { authenticateRequest, convexCliRequest, formatEndpoint } from "@/lib/api-auth";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;

  const resp = await convexCliRequest("/cli/endpoint-by-slug", {
    params: { slug, userId: auth.userId },
  });

  if (!resp.ok) return resp;

  const data = (await resp.json()) as Record<string, unknown>;
  return Response.json(formatEndpoint(data));
}

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;

  return convexCliRequest("/cli/endpoints", {
    method: "DELETE",
    body: { userId: auth.userId, slug },
  });
}
