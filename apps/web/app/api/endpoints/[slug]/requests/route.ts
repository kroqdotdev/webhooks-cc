import { authenticateRequest, convexCliRequest, formatRequest } from "@/lib/api-auth";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;
  const url = new URL(request.url);

  const queryParams: Record<string, string> = {
    slug,
    userId: auth.userId,
  };

  const limit = url.searchParams.get("limit");
  if (limit) queryParams.limit = limit;

  const since = url.searchParams.get("since");
  if (since) queryParams.since = since;

  const resp = await convexCliRequest("/cli/requests-list", {
    params: queryParams,
  });

  if (!resp.ok) return resp;

  const data: unknown[] = await resp.json();
  return Response.json(data.map((r) => formatRequest(r as Record<string, unknown>)));
}
