import { createAdminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";

export async function GET() {
  const checks: Record<string, "ok" | "error"> = {};

  // Supabase / Postgres
  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from("endpoints").select("slug").limit(1);
    checks.database = error ? "error" : "ok";
  } catch {
    checks.database = "error";
  }

  // Receiver reachability
  try {
    const { RECEIVER_INTERNAL_URL } = serverEnv();
    const res = await fetch(`${RECEIVER_INTERNAL_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    checks.receiver = res.ok ? "ok" : "error";
  } catch {
    checks.receiver = "error";
  }

  const healthy = Object.values(checks).every((v) => v === "ok");

  return Response.json(
    { status: healthy ? "ok" : "degraded", checks },
    { status: healthy ? 200 : 503 }
  );
}
