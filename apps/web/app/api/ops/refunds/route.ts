import { reportError } from "@/lib/observability";
import { listRefunds } from "@/lib/ops/refunds";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";

export async function GET(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const view = new URL(request.url).searchParams.get("view") === "recent" ? "recent" : "held";
  try {
    return opsJson(await listRefunds(view));
  } catch (error) {
    reportError("[ops] listing refunds failed", error);
    return opsJson({ error: "Refunds could not be loaded." }, { status: 500 });
  }
}
