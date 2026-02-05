import { authenticateRequest, convexCliRequest, formatEndpoint } from "@/lib/api-auth";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const resp = await convexCliRequest("/cli/endpoints", {
    params: { userId: auth.userId },
  });

  if (!resp.ok) return resp;

  const data: unknown[] = await resp.json();
  return Response.json(data.map((e) => formatEndpoint(e as Record<string, unknown>)));
}

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.name !== "string" || body.name.length === 0) {
    return Response.json({ error: "Missing or invalid 'name'" }, { status: 400 });
  }

  const resp = await convexCliRequest("/cli/endpoints", {
    method: "POST",
    body: { userId: auth.userId, name: body.name },
  });

  if (!resp.ok) return resp;

  const created = (await resp.json()) as Record<string, unknown>;
  return Response.json(formatEndpoint(created));
}
