import { reportError } from "@/lib/observability";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import { liveShares } from "@/lib/tunnels/moderation";
import { sharingOffForOps } from "@/lib/tunnels/ops-request";

/** Every live preview and live session, across accounts. */
export async function GET(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const off = sharingOffForOps();
  if (off) return off;
  try {
    return opsJson({ shares: await liveShares() });
  } catch (error) {
    reportError("[ops] listing live shares failed", error);
    return opsJson({ error: "Live shares could not be loaded." }, { status: 500 });
  }
}
