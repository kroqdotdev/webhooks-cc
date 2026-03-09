import { authenticateRequest, convexCliRequest, formatEndpoint } from "@/lib/api-auth";
import { parseJsonBody } from "@/lib/request-validation";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const resp = await convexCliRequest("/cli/endpoints", {
    params: { userId: auth.userId },
  });

  if (!resp.ok) return resp;

  const data: unknown = await resp.json();
  if (!Array.isArray(data)) {
    return Response.json({ error: "Unexpected response format" }, { status: 502 });
  }
  return Response.json(data.map((e) => formatEndpoint(e as Record<string, unknown>)));
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

  const resp = await convexCliRequest("/cli/endpoints", {
    method: "POST",
    body: {
      userId: auth.userId,
      name,
      isEphemeral,
      expiresAt,
      mockResponse: body.mockResponse,
    },
  });

  if (!resp.ok) return resp;

  const created = (await resp.json()) as Record<string, unknown>;
  return Response.json(formatEndpoint(created));
}
