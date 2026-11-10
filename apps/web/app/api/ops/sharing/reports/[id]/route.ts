import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { authenticateStaffRequest, isStaff, opsJson } from "@/lib/staff";
import { blockName, reportForOps, setSharingSuspended } from "@/lib/tunnels/moderation";
import { describeStopped, opsBody, sharingOffForOps } from "@/lib/tunnels/ops-request";
import { REPORT_KINDS } from "@/lib/tunnels/report-kinds";
import {
  findReport,
  resolveReport,
  sendStatementOfReasons,
  tellDecision,
} from "@/lib/tunnels/reports";
import { isUuid } from "@/lib/uuid";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const off = sharingOffForOps();
  if (off) return off;
  const { id } = await params;
  if (!isUuid(id)) return opsJson({ error: "Not found" }, { status: 404 });
  try {
    const report = await reportForOps(id);
    return report ? opsJson({ report }) : opsJson({ error: "Not found" }, { status: 404 });
  } catch (error) {
    reportError("[ops] reading a report failed", error);
    return opsJson({ error: "The report could not be loaded." }, { status: 500 });
  }
}

/**
 * What staff do about a report:
 * - `block_name`: block the name it is about, which stops what runs under it;
 * - `suspend` (with `confirm: true`): suspend sharing on the account behind it;
 * - `resolve` with `outcome` ("removed" or "kept") and a `note`.
 * The account is sent a statement of reasons for a takedown, except for
 * child sexual abuse; a reporter who left an email hears the decision.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const off = sharingOffForOps();
  if (off) return off;
  const { id } = await params;
  if (!isUuid(id)) return opsJson({ error: "Not found" }, { status: 404 });
  const body = await opsBody(request);
  if (body instanceof Response) return body;
  try {
    const report = await findReport(id);
    if (!report) return opsJson({ error: "Not found" }, { status: 404 });
    const label = REPORT_KINDS[report.kind].label;

    if (body.action === "block_name") {
      if (!report.name) return opsJson({ error: "That report names no preview." }, { status: 400 });
      const stopped = await blockName(report.name, `Reported: ${label}`, auth.userId);
      const told = await sendStatementOfReasons(report, "blocked");
      await auditUserAction(request, auth.userId, {
        action: "ops.name_blocked",
        status: 200,
        targetId: report.name,
        targetUserId: report.user_id,
        metadata: { reportId: report.id, statement: told },
      });
      return opsJson({
        ok: true,
        message: `Blocked ${report.name}. ${describeStopped(stopped.stopped, stopped.edgeReached)}${told ? " The account was told why." : ""}`,
        report: await reportForOps(id),
      });
    }

    if (body.action === "suspend") {
      if (body.confirm !== true)
        return opsJson({ error: "Confirm the suspension." }, { status: 400 });
      if (!report.user_id) return opsJson({ error: "No account is behind it." }, { status: 400 });
      if (await isStaff(report.user_id))
        return opsJson({ error: "Staff accounts are not suspended." }, { status: 400 });
      const stopped = await setSharingSuspended(report.user_id, true);
      if (!stopped) return opsJson({ error: "That account is gone." }, { status: 404 });
      const told = await sendStatementOfReasons(report, "suspended");
      await auditUserAction(request, auth.userId, {
        action: "ops.sharing_suspended",
        status: 200,
        targetUserId: report.user_id,
        metadata: { reportId: report.id, statement: told },
      });
      return opsJson({
        ok: true,
        message: `Sharing suspended. ${describeStopped(stopped.stopped, stopped.edgeReached)}${told ? " The account was told why." : ""}`,
        report: await reportForOps(id),
      });
    }

    if (body.action === "resolve") {
      const outcome = body.outcome === "removed" || body.outcome === "kept" ? body.outcome : null;
      if (!outcome)
        return opsJson({ error: "Say whether the preview came down." }, { status: 400 });
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (note.length < 3 || note.length > 180)
        return opsJson({ error: "Say what you did, in a few words." }, { status: 400 });
      const done = await resolveReport({ id, staffId: auth.userId, outcome, note });
      if (!done) return opsJson({ error: "It was resolved already." }, { status: 409 });
      await tellDecision(done);
      await auditUserAction(request, auth.userId, {
        action: "ops.report_resolved",
        status: 200,
        targetId: id,
        targetUserId: done.user_id,
        metadata: { outcome },
      });
      return opsJson({
        ok: true,
        message: done.reporter_email ? "Resolved. The reporter was told." : "Resolved.",
        report: await reportForOps(id),
      });
    }

    return opsJson({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    reportError("[ops] acting on a report failed", error);
    return opsJson({ error: "The action could not be completed." }, { status: 500 });
  }
}
