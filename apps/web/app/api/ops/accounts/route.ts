import { reportError } from "@/lib/observability";
import { searchAccounts } from "@/lib/ops/accounts";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";

/** Accounts by email, id or endpoint slug; the newest without a query. */
export async function GET(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const q = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 200);
  try {
    return opsJson(await searchAccounts(q));
  } catch (error) {
    reportError("[ops] account search failed", error);
    return opsJson({ error: "The search failed." }, { status: 500 });
  }
}
