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

  const isEphemeral = body.isEphemeral === true;

  const resp = await convexCliRequest("/cli/endpoints", {
    method: "POST",
    body: { userId: auth.userId, name, isEphemeral },
  });

  if (!resp.ok) return resp;

  const created = (await resp.json()) as Record<string, unknown>;
  return Response.json(formatEndpoint(created));
}
