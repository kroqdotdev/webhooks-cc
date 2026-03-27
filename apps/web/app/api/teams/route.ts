import { authenticateRequest } from "@/lib/api-auth";
import { createTeam, listTeamsForUser } from "@/lib/supabase/teams";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  try {
    const teams = await listTeamsForUser(auth.userId);
    return Response.json(teams);
  } catch (error) {
    console.error("Failed to list teams:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0 || name.length > 100) {
    return Response.json({ error: "Name must be between 1 and 100 characters" }, { status: 400 });
  }

  try {
    const team = await createTeam(auth.userId, name);
    return Response.json(team);
  } catch (error) {
    console.error("Failed to create team:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
