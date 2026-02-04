import { authenticateRequest, convexCliRequest } from "@/lib/api-auth";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;

  return convexCliRequest("/cli/endpoints", {
    params: { userId: auth.userId },
  });
}

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  return convexCliRequest("/cli/endpoints", {
    method: "POST",
    body: { userId: auth.userId, name: body.name },
  });
}
