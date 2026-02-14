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
  }

  const resp = await convexCliRequest("/cli/endpoints", {
    method: "PATCH",
    body: { userId: auth.userId, slug, name: body.name, mockResponse: body.mockResponse },
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
