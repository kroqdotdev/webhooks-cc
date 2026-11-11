import { auditUserAction } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import {
  checkReputation,
  lastReputation,
  reputationConfigured,
  reputationUri,
} from "@/lib/tunnels/reputation";
import { reportError } from "@/lib/observability";

async function recentListings() {
  const { data, error } = await createAdminClient()
    .from("abuse_reports")
    .select("id, kind, status, outcome, details, created_at, resolved_at")
    .eq("source", "reputation")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    outcome: r.outcome,
    details: r.details,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }));
}

/** The preview domain's last Web Risk check and the listings it opened. */
export async function GET(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  try {
    return opsJson({
      configured: reputationConfigured(),
      uri: reputationUri(),
      last: lastReputation(),
      listings: await recentListings(),
    });
  } catch (error) {
    reportError("[ops] reading reputation failed", error);
    return opsJson({ error: "Reputation could not be loaded." }, { status: 500 });
  }
}

/** Checks now rather than waiting for the day's check. */
export async function POST(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  if (!reputationConfigured())
    return opsJson({ error: "WEB_RISK_API_KEY is not set on this server." }, { status: 503 });
  const last = await checkReputation();
  await auditUserAction(request, auth.userId, {
    action: "ops.reputation_checked",
    status: 200,
    metadata: { listed: (last?.threats.length ?? 0) > 0, failed: Boolean(last?.error) },
  });
  return opsJson({ ok: true, last, listings: await recentListings() });
}
