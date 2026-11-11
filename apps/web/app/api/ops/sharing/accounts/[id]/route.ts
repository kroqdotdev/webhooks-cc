import { auditUserAction, type AuditAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { authenticateStaffRequest, isStaff, opsJson } from "@/lib/staff";
import { accountSharing, setNoticeLifted, setSharingSuspended } from "@/lib/tunnels/moderation";
import { describeStopped, opsBody, sharingOffForOps } from "@/lib/tunnels/ops-request";
import { stopShares } from "@/lib/tunnels/stops";
import { isUuid } from "@/lib/uuid";

type Params = { params: Promise<{ id: string }> };

/** An account's sharing: suspended or not, the notice, its live runs. */
export async function GET(request: Request, { params }: Params) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const off = sharingOffForOps();
  if (off) return off;
  const { id } = await params;
  if (!isUuid(id)) return opsJson({ error: "Not found" }, { status: 404 });
  try {
    const account = await accountSharing(id);
    if (!account) return opsJson({ error: "Not found" }, { status: 404 });
    return opsJson({ account });
  } catch (error) {
    reportError("[ops] reading an account's sharing failed", error);
    return opsJson({ error: "Sharing could not be loaded." }, { status: 500 });
  }
}

const ACTIONS: Record<string, AuditAction> = {
  stop_all: "ops.account_shares_stopped",
  suspend: "ops.sharing_suspended",
  restore: "ops.sharing_restored",
  lift_notice: "ops.share_notice_lifted",
  restore_notice: "ops.share_notice_restored",
};

/**
 * `stop_all` (every live run), `suspend` (stops them and refuses new ones;
 * needs `confirm: true`), `restore`, `lift_notice` (the new-account visitor
 * notice) and `restore_notice`.
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
  const action = typeof body.action === "string" ? body.action : "";
  const audit = ACTIONS[action];
  if (!audit) return opsJson({ error: "Unknown action." }, { status: 400 });
  if (action === "suspend" && body.confirm !== true)
    return opsJson({ error: "Confirm the suspension." }, { status: 400 });
  try {
    let message: string;
    let found = true;
    if (action === "stop_all") {
      const r = await stopShares({ userId: id }, "staff");
      message = describeStopped(r.stopped, r.edgeReached);
    } else if (action === "suspend" || action === "restore") {
      // As from a report: staff accounts are never suspended.
      if (action === "suspend" && (await isStaff(id)))
        return opsJson({ error: "Staff accounts are not suspended." }, { status: 400 });
      const r = await setSharingSuspended(id, action === "suspend");
      found = r !== null;
      message =
        action === "suspend" && r
          ? `Sharing suspended. ${describeStopped(r.stopped, r.edgeReached)}`
          : "Sharing restored.";
    } else {
      found = await setNoticeLifted(id, action === "lift_notice");
      message =
        action === "lift_notice"
          ? "The visitor notice is lifted for new shares."
          : "The visitor notice applies again for new shares.";
    }
    if (!found) return opsJson({ error: "Not found" }, { status: 404 });
    await auditUserAction(request, auth.userId, {
      action: audit,
      status: 200,
      targetUserId: id,
    });
    return opsJson({ ok: true, message, account: await accountSharing(id) });
  } catch (error) {
    reportError("[ops] changing an account's sharing failed", error);
    return opsJson({ error: "The change could not be saved." }, { status: 500 });
  }
}
