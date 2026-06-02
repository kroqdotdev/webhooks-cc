import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { listPaginatedRequestsForEndpointByUser } from "@/lib/supabase/requests";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;
  const url = new URL(request.url);

  const limit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const parsedLimit = limit ? Number(limit) : undefined;

  if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit < 1)) {
    return Response.json({ error: "invalid_limit" }, { status: 400 });
  }

  try {
    const page = await listPaginatedRequestsForEndpointByUser({
      userId: auth.userId,
      slug,
      limit: parsedLimit,
      cursor: cursor ?? undefined,
    });

    if (!page) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return Response.json(page);
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_cursor") {
      return Response.json({ error: "invalid_cursor" }, { status: 400 });
    }

    console.error("Failed to list paginated requests:", error);
    return Response.json({ error: "Failed to list paginated requests" }, { status: 500 });
  }
}
