import { authenticateRequest } from "@/lib/api-auth";
import {
  deleteEndpointBySlugForUser,
  getEndpointBySlugForUser,
  updateEndpointBySlugForUser,
} from "@/lib/supabase/endpoints";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;

  try {
    const endpoint = await getEndpointBySlugForUser(auth.userId, slug);
    if (!endpoint) {
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    }

    return Response.json(endpoint);
  } catch (error) {
    console.error("Failed to fetch endpoint:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate name type and length if provided
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.length > 100)) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }

  // Validate mockResponse structure if provided
  if (body.mockResponse !== undefined && body.mockResponse !== null) {
    if (typeof body.mockResponse !== "object" || Array.isArray(body.mockResponse)) {
      return Response.json({ error: "Invalid mockResponse" }, { status: 400 });
    }
    const mr = body.mockResponse as Record<string, unknown>;
    if (
      mr.status !== undefined &&
      (typeof mr.status !== "number" || mr.status < 100 || mr.status > 599)
    ) {
      return Response.json({ error: "Invalid status code" }, { status: 400 });
    }
    if (mr.body !== undefined && typeof mr.body !== "string") {
      return Response.json({ error: "Invalid mockResponse body" }, { status: 400 });
    }
    if (mr.headers !== undefined) {
      if (typeof mr.headers !== "object" || Array.isArray(mr.headers)) {
        return Response.json({ error: "Invalid mockResponse headers" }, { status: 400 });
      }
      for (const val of Object.values(mr.headers as Record<string, unknown>)) {
        if (typeof val !== "string") {
          return Response.json({ error: "Invalid mockResponse headers" }, { status: 400 });
        }
      }
    }
    if (
      mr.delay !== undefined &&
      (typeof mr.delay !== "number" ||
        !Number.isInteger(mr.delay) ||
        mr.delay < 0 ||
        mr.delay > 30000)
    ) {
      return Response.json({ error: "Invalid delay: must be 0-30000ms" }, { status: 400 });
    }
  }

  try {
    const endpoint = await updateEndpointBySlugForUser({
      userId: auth.userId,
      slug,
      name: body.name as string | undefined,
      mockResponse:
        body.mockResponse === undefined
          ? undefined
          : (body.mockResponse as Record<string, unknown> | null),
    });

    if (!endpoint) {
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    }

    return Response.json(endpoint);
  } catch (error) {
    console.error("Failed to update endpoint:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;

  try {
    const deleted = await deleteEndpointBySlugForUser(auth.userId, slug);
    if (!deleted) {
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Failed to delete endpoint:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
