import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { accountDetail } from "@/lib/ops/accounts";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/uuid";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

/** An account's metadata. Never request or email contents. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const { id } = await params;
  if (!isUuid(id)) return opsJson({ error: "Not found" }, { status: 404 });
  try {
    const detail = await accountDetail(id);
    if (!detail) return opsJson({ error: "Not found" }, { status: 404 });
    await auditUserAction(request, auth.userId, {
      action: "ops.account_viewed",
      status: 200,
      targetUserId: id,
    });
    return opsJson(detail);
  } catch (error) {
    reportError("[ops] reading an account failed", error);
    return opsJson({ error: "The account could not be loaded." }, { status: 500 });
  }
}

const accountChanges = z.object({ internal: z.unknown().optional() });

/** Marks a test account internal, so the metrics leave it out. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const { id } = await params;
  if (!isUuid(id)) return opsJson({ error: "Not found" }, { status: 404 });
  const parsed = await parseJsonBodyWith(request, accountChanges, {
    message: "Invalid JSON.",
    respond: opsJson,
  });
  if ("error" in parsed) return parsed.error;
  const body = parsed.data;
  if (typeof body.internal !== "boolean") {
    return opsJson({ error: "Nothing to change." }, { status: 400 });
  }
  const { error } = await createAdminClient()
    .from("users")
    .update({ internal: body.internal })
    .eq("id", id);
  if (error) {
    reportError("[ops] marking an account internal failed", error);
    return opsJson({ error: "The change could not be saved." }, { status: 500 });
  }
  await auditUserAction(request, auth.userId, {
    action: "ops.account_updated",
    status: 200,
    targetUserId: id,
    metadata: { internal: body.internal },
  });
  return opsJson({ internal: body.internal });
}
