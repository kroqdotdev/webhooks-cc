import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import { reportsForOps } from "@/lib/tunnels/moderation";
import { opsBody, sharingOffForOps } from "@/lib/tunnels/ops-request";
import { createReport, reportedNameOf } from "@/lib/tunnels/reports";

/** Open reports (child sexual abuse first) or the latest resolved ones. */
export async function GET(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const off = sharingOffForOps();
  if (off) return off;
  const view = new URL(request.url).searchParams.get("view") === "resolved" ? "resolved" : "open";
  try {
    return opsJson({ reports: await reportsForOps(view) });
  } catch (error) {
    reportError("[ops] listing reports failed", error);
    return opsJson({ error: "Reports could not be loaded." }, { status: 500 });
  }
}

/**
 * An address Cloudflare's CSAM Scanning Tool matched (its daily email),
 * opened as a report so the steps and the details for the police are in one
 * place.
 */
export async function POST(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const off = sharingOffForOps();
  if (off) return off;
  const body = await opsBody(request);
  if (body instanceof Response) return body;
  const url = typeof body.url === "string" ? body.url.trim().slice(0, 2000) : "";
  const name = url ? reportedNameOf(url) : null;
  if (!name) return opsJson({ error: "Paste a preview's address." }, { status: 400 });
  try {
    const report = await createReport({
      url,
      name,
      kind: "csam",
      details: "Cloudflare's CSAM Scanning Tool matched an image here.",
      reporterName: null,
      reporterEmail: null,
      goodFaith: true,
      source: "flag",
    });
    await auditUserAction(request, auth.userId, {
      action: "ops.report_recorded",
      status: 200,
      targetId: report.id,
      targetUserId: report.user_id,
    });
    return opsJson({ ok: true, id: report.id });
  } catch (error) {
    reportError("[ops] recording a match failed", error);
    return opsJson({ error: "The report could not be saved." }, { status: 500 });
  }
}
