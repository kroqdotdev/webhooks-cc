import { staffSession, opsJson } from "@/lib/staff";
import { waitingCount } from "@/lib/ops/tickets";
import { tunnelConfig } from "@/lib/tunnels/config";
import { openReportCount } from "@/lib/tunnels/reports";

/**
 * Whether the signed-in person is staff, for the account menu and the ops
 * shell. Anyone else gets the same 404 as every other ops route.
 */
export async function GET(request: Request) {
  const session = await staffSession(request);
  if (!session) return opsJson({ error: "Not found" }, { status: 404 });
  let waiting: number | null = null;
  // Open reports of shared previews, when sharing is configured here.
  let reports: number | null = null;
  if (session.aal2) {
    try {
      waiting = await waitingCount();
    } catch {
      waiting = null;
    }
    if (tunnelConfig()) {
      try {
        reports = await openReportCount();
      } catch {
        reports = null;
      }
    }
  }
  return opsJson({
    staff: true,
    aal2: session.aal2,
    hasFactor: session.hasFactor,
    waiting,
    reports,
  });
}
