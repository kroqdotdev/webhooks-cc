import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import { textField } from "@/lib/support/form";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/uuid";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

// A reply's text is cut to 20,000 characters, which can be more bytes than
// the default limit allows.
const SAVED_REPLY_MAX_BYTES = 256 * 1024;
const savedReplyBody = z.object({ title: z.unknown().optional(), body: z.unknown().optional() });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const { id } = await params;
  if (!isUuid(id)) return opsJson({ error: "Not found" }, { status: 404 });
  const parsed = await parseJsonBodyWith(request, savedReplyBody, {
    message: "Invalid JSON.",
    respond: opsJson,
    maxSize: SAVED_REPLY_MAX_BYTES,
  });
  if ("error" in parsed) return parsed.error;
  const body = parsed.data;
  const title = textField(body.title).slice(0, 120);
  const text = textField(body.body);
  if (!title || !text) return opsJson({ error: "Give it a title and a text." }, { status: 400 });
  const { data, error } = await createAdminClient()
    .from("support_saved_replies")
    .update({ title, body: text.slice(0, 20000), updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id, title, body, updated_at")
    .maybeSingle();
  if (error) {
    reportError("[ops] updating a saved reply failed", error);
    return opsJson({ error: "The saved reply could not be changed." }, { status: 500 });
  }
  if (!data) return opsJson({ error: "Not found" }, { status: 404 });
  await auditUserAction(request, auth.userId, {
    action: "ops.saved_reply_changed",
    status: 200,
    targetId: id,
  });
  return opsJson(data);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const { id } = await params;
  if (!isUuid(id)) return opsJson({ error: "Not found" }, { status: 404 });
  const { error } = await createAdminClient().from("support_saved_replies").delete().eq("id", id);
  if (error) {
    reportError("[ops] deleting a saved reply failed", error);
    return opsJson({ error: "The saved reply could not be deleted." }, { status: 500 });
  }
  await auditUserAction(request, auth.userId, {
    action: "ops.saved_reply_changed",
    status: 204,
    targetId: id,
    metadata: { deleted: true },
  });
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
