import { authenticateRequest, convexCliRequest } from "@/lib/api-auth";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const resp = await convexCliRequest("/cli/usage", {
    params: { userId: auth.userId },
  });

  if (!resp.ok) return resp;

  const data: unknown = await resp.json();
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return Response.json({ error: "Unexpected response format" }, { status: 502 });
  }

  return Response.json(data);
}
