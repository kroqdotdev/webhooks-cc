import { authenticateRequest } from "@/lib/api-auth";
import {
  clearRequestsForEndpointByUser,
  listRequestsForEndpointByUser,
} from "@/lib/supabase/requests";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;
  const url = new URL(request.url);

  const limit = url.searchParams.get("limit");
  const since = url.searchParams.get("since");
  const parsedLimit = limit ? Number(limit) : undefined;
  const parsedSince = since ? Number(since) : undefined;

  if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit < 1)) {
    return Response.json({ error: "invalid_limit" }, { status: 400 });
  }
  if (parsedSince !== undefined && (!Number.isFinite(parsedSince) || parsedSince < 0)) {
    return Response.json({ error: "invalid_since" }, { status: 400 });
  }

  try {
    const data = await listRequestsForEndpointByUser({
      userId: auth.userId,
      slug,
      limit: parsedLimit,
      since: parsedSince,
    });

    if (!data) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return Response.json(data);
  } catch (error) {
    console.error("Failed to list requests:", error);
    return Response.json({ error: "Failed to list requests" }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;
  const url = new URL(request.url);
  const beforeRaw = url.searchParams.get("before");
  let before: number | undefined;

  if (beforeRaw !== null) {
    before = Number(beforeRaw);
    if (!Number.isFinite(before) || before < 0) {
      return Response.json({ error: "Invalid before timestamp" }, { status: 400 });
    }
  }

  try {
    const data = await clearRequestsForEndpointByUser({
      slug,
      userId: auth.userId,
      before,
    });

    if (!data) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Failed to clear requests:", error);
    return Response.json({ error: "Failed to clear requests" }, { status: 500 });
  }
}
