import { authenticateRequestRequireUser } from "@/lib/api-auth";
import {
  getRequestByIdForUser,
  parseExtractsParam,
  withEmailExtracts,
} from "@/lib/supabase/requests";
import { reportError } from "@/lib/observability";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { id } = await params;
  const extracts = parseExtractsParam(new URL(request.url).searchParams.get("extracts"));
  if (extracts === null) {
    return Response.json({ error: "invalid_extracts" }, { status: 400 });
  }

  try {
    const data = await getRequestByIdForUser(auth.userId, id);
    if (!data) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return Response.json(extracts ? (await withEmailExtracts([data]))[0] : data);
  } catch (error) {
    reportError("Failed to get request", error);
    return Response.json({ error: "Failed to get request" }, { status: 500 });
  }
}
