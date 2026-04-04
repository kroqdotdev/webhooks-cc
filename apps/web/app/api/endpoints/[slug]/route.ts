import { authenticateRequest } from "@/lib/api-auth";
import { validateNotificationUrl, validateMockResponseField } from "@/lib/request-validation";
import {
  deleteEndpointBySlugForUser,
  getEndpointBySlugForUser,
  updateEndpointBySlugForUser,
} from "@/lib/supabase/endpoints";
import { resolveEndpointAccess } from "@/lib/supabase/teams";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;

  try {
    const access = await resolveEndpointAccess(auth.userId, slug);
    if (!access) {
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    }

    const endpoint = await getEndpointBySlugForUser(access.ownerId, slug);
    if (!endpoint) {
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    }

    // Strip notification URL for non-owners — it's a bearer secret (Slack/Discord)
    if (access.ownerId !== auth.userId) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { notificationUrl, ...safe } = endpoint;
      return Response.json(safe);
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

  const notifCheck = validateNotificationUrl(body.notificationUrl);
  if (!notifCheck.valid) return notifCheck.response;

  const mockCheck = validateMockResponseField(body.mockResponse, true);
  if (!mockCheck.valid) return mockCheck.response;

  try {
    // Allow team members to edit (they can rename + change mock response)
    const access = await resolveEndpointAccess(auth.userId, slug);
    if (!access) {
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    }

    const endpoint = await updateEndpointBySlugForUser({
      userId: access.ownerId,
      slug,
      name: body.name as string | undefined,
      mockResponse:
        body.mockResponse === undefined
          ? undefined
          : (body.mockResponse as Record<string, unknown> | null),
      notificationUrl:
        body.notificationUrl === undefined
          ? undefined
          : body.notificationUrl === null || body.notificationUrl === ""
            ? null
            : (body.notificationUrl as string),
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
