import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import { textField } from "@/lib/support/form";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

export async function GET(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const { data, error } = await createAdminClient()
    .from("support_saved_replies")
    .select("id, title, body, updated_at")
    .order("title", { ascending: true });
  if (error) {
    reportError("[ops] listing saved replies failed", error);
    return opsJson({ error: "Saved replies could not be loaded." }, { status: 500 });
  }
  return opsJson(data ?? []);
}

// A reply's text is cut to 20,000 characters, which can be more bytes than
// the default limit allows.
const SAVED_REPLY_MAX_BYTES = 256 * 1024;
const savedReplyBody = z.object({ title: z.unknown().optional(), body: z.unknown().optional() });

export async function POST(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
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
    .insert({ title, body: text.slice(0, 20000) })
    .select("id, title, body, updated_at")
    .single();
  if (error) {
    reportError("[ops] saving a reply failed", error);
    return opsJson({ error: "The saved reply could not be created." }, { status: 500 });
  }
  await auditUserAction(request, auth.userId, {
    action: "ops.saved_reply_changed",
    status: 201,
    targetId: data.id,
  });
  return opsJson(data, { status: 201 });
}
