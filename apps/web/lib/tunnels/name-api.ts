import { createAdminClient } from "@/lib/supabase/admin";
import { previewUrl } from "./config";
import type { UsableName } from "./names";

/** A kept name as the API shows it (GET /api/tunnel-names). */
export interface ApiName {
  name: string;
  url: string | null;
  team: { id: string; name: string } | null;
  reservedBy: { id: string; email: string } | null;
  mine: boolean;
  password: boolean;
  live: boolean;
  createdAt: string;
}

export async function apiNames(names: UsableName[]): Promise<ApiName[]> {
  if (names.length === 0) return [];
  const admin = createAdminClient();
  const teamIds = [...new Set(names.map((n) => n.teamId).filter((x): x is string => !!x))];
  const [teams, live] = await Promise.all([
    teamIds.length > 0
      ? admin.from("teams").select("id, name").in("id", teamIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
    admin
      .from("tunnel_shares")
      .select("name")
      .in(
        "name",
        names.map((n) => n.name)
      )
      .eq("kind", "share")
      .is("ended_at", null),
  ]);
  if (teams.error) throw teams.error;
  if (live.error) throw live.error;
  const teamName = new Map((teams.data ?? []).map((t) => [t.id, t.name]));
  const running = new Set((live.data ?? []).map((s) => s.name));
  return names.map((n) => ({
    name: n.name,
    url: previewUrl(n.name),
    team: n.teamId ? { id: n.teamId, name: teamName.get(n.teamId) ?? "" } : null,
    reservedBy: n.reservedBy,
    mine: n.mine,
    password: n.password,
    live: running.has(n.name),
    createdAt: n.createdAt,
  }));
}
