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

  const cursor = url.searchParams.get("cursor");
  if (cursor) queryParams.cursor = cursor;

  const resp = await convexCliRequest("/cli/requests-list-paginated", {
    params: queryParams,
  });

  if (!resp.ok) return resp;

  const data: unknown = await resp.json();
  if (
    typeof data !== "object" ||
    data === null ||
    !("items" in data) ||
    !Array.isArray((data as { items: unknown }).items)
  ) {
    return Response.json({ error: "Unexpected response format" }, { status: 502 });
  }

  const page = data as { items: Array<Record<string, unknown>>; cursor?: string; hasMore: boolean };
  return Response.json({
    items: page.items.map((item) => formatRequest(item)),
    cursor: page.cursor,
    hasMore: page.hasMore,
  });
}
