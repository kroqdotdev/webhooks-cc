import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { requestApproval } from "@/lib/approvals/request";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ApiKeyLimitError,
  createApiKeyForUser,
  MAX_KEY_TTL_DAYS,
  parseKeyName,
} from "@/lib/supabase/api-keys";
import { reportError } from "@/lib/observability";
import { closeRunsWithoutAccess } from "@/lib/tunnels/access";
import { tunnelConfig } from "@/lib/tunnels/config";
import { stopShares } from "@/lib/tunnels/stops";

const DEFAULT_TTL_DAYS = 365;

/*
 * The account's API keys. Listing and revoking take a browser session or any
 * key of the account (a read, and a revoke only ever takes access away).
 * Creating one with a session creates it; with an API key or an agent token
 * it answers 202 with an approval the account's owner must give
 * (lib/approvals), and the key goes to the asker when it collects it.
 */

export async function GET(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_keys")
    .select("id, name, key_prefix, created_at, expires_at, last_used_at")
    .eq("user_id", auth.userId)
    // Agent access tokens are short-lived and belong to their registration;
    // the account lists them as connected agents, not as keys.
    .is("agent_registration_id", null)
    .order("created_at", { ascending: false });

  if (error) {
    reportError("Failed to list API keys", error);
    return Response.json({ error: "Failed to list API keys" }, { status: 500 });
  }

  return Response.json(data ?? []);
}

export async function POST(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  // An API key or an agent token: a person approves it first.
  if (auth.keyId) {
    return requestApproval(
      request,
      { userId: auth.userId, keyId: auth.keyId, agentRegistrationId: auth.agentRegistrationId },
      "api_keys.create",
      body
    );
  }

  const name = parseKeyName(body.name);
  if (!name.ok) {
    return Response.json({ error: name.error }, { status: 400 });
  }
  const days = body.expiresInDays ?? DEFAULT_TTL_DAYS;
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > MAX_KEY_TTL_DAYS) {
    return Response.json(
      { error: `expiresInDays must be a whole number of days from 1 to ${MAX_KEY_TTL_DAYS}` },
      { status: 400 }
    );
  }

  try {
    const created = await createApiKeyForUser(auth.userId, name.name, days as number);
    await auditUserAction(request, auth.userId, {
      action: "api_key.created",
      status: 200,
      targetId: created.keyPrefix,
      metadata: { name: created.name },
    });
    return Response.json(created);
  } catch (err) {
    if (err instanceof ApiKeyLimitError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    reportError("Failed to create API key", err);
    await auditUserAction(request, auth.userId, { action: "api_key.created", status: 500 });
    return Response.json({ error: "Failed to create API key" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const url = new URL(request.url);
  const keyId = url.searchParams.get("id");
  if (!keyId) {
    return Response.json({ error: "Missing key id" }, { status: 400 });
  }

  const admin = createAdminClient();
  // Shares the key opened stop with it (the CLI is told to log in again).
  // Before the delete: the runs lose their key id when the key goes.
  if (tunnelConfig()) {
    await stopShares({ keyId, userId: auth.userId }, "revoked").catch((err) =>
      reportError("Failed to stop the shares of a deleted API key", err)
    );
  }
  const { data: deletedKeys, error } = await admin
    .from("api_keys")
    .delete()
    .eq("id", keyId)
    .eq("user_id", auth.userId)
    .is("agent_registration_id", null)
    .select("key_prefix");

  if (error) {
    reportError("Failed to delete API key", error);
    await auditUserAction(request, auth.userId, {
      action: "api_key.deleted",
      status: 500,
      targetId: keyId,
    });
    return Response.json({ error: "Failed to delete API key" }, { status: 500 });
  }

  // A run that opened with the key while it was being deleted lost its key id
  // with the delete; tunnel_runs_without_access() ends it as "key revoked".
  if (tunnelConfig() && deletedKeys && deletedKeys.length > 0) await closeRunsWithoutAccess();

  // The route answers 200 even when no key matched, so the audit row does too;
  // `deleted` records whether a key was actually removed.
  const deletedPrefix = deletedKeys?.[0]?.key_prefix ?? null;
  await auditUserAction(request, auth.userId, {
    action: "api_key.deleted",
    status: 200,
    targetId: deletedPrefix ?? keyId,
    metadata: { deleted: deletedPrefix !== null },
  });
  return Response.json({ success: true });
}
