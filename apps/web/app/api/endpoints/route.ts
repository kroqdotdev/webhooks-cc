import { authenticateRequest } from "@/lib/api-auth";
import { parseJsonBody } from "@/lib/request-validation";
import { createEndpointForUser, listEndpointsForUser } from "@/lib/supabase/endpoints";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  try {
    const endpoints = await listEndpointsForUser(auth.userId);
    return Response.json(endpoints);
  } catch (error) {
    console.error("Failed to list endpoints:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const parsed = await parseJsonBody(request);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  if (name !== undefined && (name.length === 0 || name.length > 100)) {
    return Response.json({ error: "Name must be between 1 and 100 characters" }, { status: 400 });
  }

  if (body.isEphemeral !== undefined && typeof body.isEphemeral !== "boolean") {
    return Response.json({ error: "isEphemeral must be a boolean" }, { status: 400 });
  }

  const expiresAt =
    typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
      ? body.expiresAt
      : undefined;
  if (body.expiresAt !== undefined && (expiresAt === undefined || expiresAt <= Date.now())) {
    return Response.json({ error: "expiresAt must be a future timestamp" }, { status: 400 });
  }

  if (body.mockResponse !== undefined && body.mockResponse !== null) {
    if (typeof body.mockResponse !== "object" || Array.isArray(body.mockResponse)) {
      return Response.json({ error: "Invalid mockResponse" }, { status: 400 });
    }
    const mr = body.mockResponse as Record<string, unknown>;
    if (
      typeof mr.status !== "number" ||
      mr.status < 100 ||
      mr.status > 599 ||
      !Number.isInteger(mr.status)
    ) {
      return Response.json({ error: "Invalid status code" }, { status: 400 });
    }
    if (typeof mr.body !== "string") {
      return Response.json({ error: "Invalid mockResponse body" }, { status: 400 });
    }
    if (typeof mr.headers !== "object" || mr.headers === null || Array.isArray(mr.headers)) {
      return Response.json({ error: "Invalid mockResponse headers" }, { status: 400 });
    }
    for (const val of Object.values(mr.headers as Record<string, unknown>)) {
      if (typeof val !== "string") {
        return Response.json({ error: "Invalid mockResponse headers" }, { status: 400 });
      }
    }
  }

  const isEphemeral = body.isEphemeral === true || expiresAt !== undefined;

  try {
    const created = await createEndpointForUser({
      userId: auth.userId,
      name,
      isEphemeral,
      expiresAt,
    });

    return Response.json(created);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Too many active demo endpoints")) {
      return Response.json({ error: error.message }, { status: 429 });
    }

    console.error("Failed to create endpoint:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
