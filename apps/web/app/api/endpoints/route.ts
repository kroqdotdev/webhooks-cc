import { authenticateRequest, convexCliRequest } from "@/lib/api-auth";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  return convexCliRequest("/cli/endpoints", {
    params: { userId: auth.userId },
  });
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

  return convexCliRequest("/cli/endpoints", {
    method: "POST",
    body: { userId: auth.userId, name: body.name },
  });
}
