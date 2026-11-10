import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import {
  blockName,
  blockNameProblem,
  blockWord,
  blockWordProblem,
  blockedLists,
  unblockName,
  unblockWord,
} from "@/lib/tunnels/moderation";
import { describeStopped, opsBody, reasonOf, sharingOffForOps } from "@/lib/tunnels/ops-request";

/** Staff's blocked names and words, and the built-in lists. */
export async function GET(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const off = sharingOffForOps();
  if (off) return off;
  try {
    return opsJson(await blockedLists());
  } catch (error) {
    reportError("[ops] listing blocks failed", error);
    return opsJson({ error: "Blocks could not be loaded." }, { status: 500 });
  }
}

function target(body: Record<string, unknown>): { kind: "name" | "word"; value: string } | null {
  const kind = body.kind === "name" || body.kind === "word" ? body.kind : null;
  const value = typeof body.value === "string" ? body.value.trim().toLowerCase() : "";
  return kind && value ? { kind, value } : null;
}

/** Blocks a name (stopping what runs under it) or a word in new names. */
export async function POST(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const off = sharingOffForOps();
  if (off) return off;
  const body = await opsBody(request);
  if (body instanceof Response) return body;
  const which = target(body);
  if (!which) return opsJson({ error: "Give a name or a word." }, { status: 400 });
  const problem =
    which.kind === "name" ? blockNameProblem(which.value) : blockWordProblem(which.value);
  if (problem) return opsJson({ error: problem }, { status: 400 });
  const reason = reasonOf(body.reason);
  if (!reason) return opsJson({ error: "Say why, in a few words." }, { status: 400 });
  try {
    let message: string;
    if (which.kind === "name") {
      const r = await blockName(which.value, reason, auth.userId);
      message = `Blocked ${which.value}. ${describeStopped(r.stopped, r.edgeReached)}`;
    } else {
      await blockWord(which.value, reason, auth.userId);
      message = `Blocked the word ${which.value} in new names.`;
    }
    await auditUserAction(request, auth.userId, {
      action: which.kind === "name" ? "ops.name_blocked" : "ops.word_blocked",
      status: 200,
      targetId: which.value,
    });
    return opsJson({ ok: true, message });
  } catch (error) {
    reportError("[ops] blocking failed", error);
    return opsJson({ error: "The block could not be saved." }, { status: 500 });
  }
}

/** Takes a name or word off staff's list. */
export async function DELETE(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const off = sharingOffForOps();
  if (off) return off;
  const body = await opsBody(request);
  if (body instanceof Response) return body;
  const which = target(body);
  if (!which) return opsJson({ error: "Give a name or a word." }, { status: 400 });
  try {
    const removed =
      which.kind === "name" ? await unblockName(which.value) : await unblockWord(which.value);
    if (!removed) return opsJson({ error: "It was not blocked." }, { status: 404 });
    await auditUserAction(request, auth.userId, {
      action: which.kind === "name" ? "ops.name_unblocked" : "ops.word_unblocked",
      status: 200,
      targetId: which.value,
    });
    return opsJson({ ok: true });
  } catch (error) {
    reportError("[ops] unblocking failed", error);
    return opsJson({ error: "The block could not be removed." }, { status: 500 });
  }
}
