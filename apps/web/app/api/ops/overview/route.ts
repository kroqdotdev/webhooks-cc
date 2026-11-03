import { reportError } from "@/lib/observability";
import { opsOverview } from "@/lib/ops/metrics";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";

export async function GET(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  try {
    return opsJson(await opsOverview());
  } catch (error) {
    reportError("[ops] overview failed", error);
    return opsJson({ error: "The overview could not be loaded." }, { status: 500 });
  }
}
