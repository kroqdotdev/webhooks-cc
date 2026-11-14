import { userCodePart } from "@/lib/ids";
import { reportError } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database";
import { compareNetworks, type DeviceRequester, type NetworkMatch } from "@/lib/device-requester";
import { ActionError, actionSpec, type ActionDetail, type ApprovalAction } from "./actions";

/** How long a person has to answer, and then the asker to collect. */
export const APPROVAL_TTL_MS = 15 * 60_000;
/** Pending approvals an account may have at once. */
export const MAX_PENDING_APPROVALS = 10;

export type ApprovalStatus = "pending" | "approved" | "denied" | "completed" | "expired";

/** Who asked: the API key, or the agent registration whose token asked. */
export interface Asker {
  userId: string;
  keyId?: string;
  agentRegistrationId?: string | null;
}

export interface ApprovalView {
  id: string;
  status: ApprovalStatus;
  action: ApprovalAction;
  summary: string;
  code: string;
  url: string;
  expiresAt: string;
}

export class ApprovalError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

type Row = {
  id: string;
  user_id: string;
  action: ApprovalAction;
  params: Json;
  summary: string;
  user_code: string;
  status: "pending" | "approved" | "denied" | "completed";
  requested_by_key: string | null;
  requested_by_agent: string | null;
  requester: string;
  client: string | null;
  country: string | null;
  network: string | null;
  created_at: string;
  expires_at: string;
  result: Json | null;
};

const COLUMNS =
  "id, user_id, action, params, summary, user_code, status, requested_by_key, requested_by_agent, requester, client, country, network, created_at, expires_at, result";

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "https://webhooks.cc";
}

/** approvals.summary holds at most this many characters (migration 00097). */
const MAX_SUMMARY = 300;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function statusOf(row: Pick<Row, "status" | "expires_at">): ApprovalStatus {
  const expired = new Date(row.expires_at).getTime() <= Date.now();
  if ((row.status === "pending" || row.status === "approved") && expired) return "expired";
  return row.status;
}

function view(row: Row): ApprovalView {
  return {
    id: row.id,
    status: statusOf(row),
    action: row.action,
    summary: row.summary,
    code: row.user_code,
    url: `${appUrl()}/approve?code=${encodeURIComponent(row.user_code)}`,
    expiresAt: row.expires_at,
  };
}

/** How the page names whoever asked, from the key or registration behind the token. */
async function requesterLabel(asker: Asker): Promise<string> {
  const admin = createAdminClient();
  if (asker.agentRegistrationId) {
    const { data } = await admin
      .from("agent_registrations")
      .select("client_name")
      .eq("id", asker.agentRegistrationId)
      .maybeSingle();
    const name = data?.client_name?.trim();
    return name ? `the connected agent "${name}"` : "a connected agent";
  }
  if (asker.keyId) {
    const { data } = await admin
      .from("api_keys")
      .select("name, key_prefix")
      .eq("id", asker.keyId)
      .maybeSingle();
    if (data) return `the API key "${data.name}" (${data.key_prefix}...)`;
  }
  return "an API key";
}

/**
 * Records an approval for the asker's account. The action's parameters were
 * checked by the caller (parseApprovalParams).
 */
export async function createApproval(input: {
  asker: Asker;
  action: ApprovalAction;
  params: unknown;
  requester: DeviceRequester;
}): Promise<{ approval: ApprovalView; requester: string }> {
  const admin = createAdminClient();
  const { count, error: countError } = await admin
    .from("approvals")
    .select("id", { count: "exact", head: true })
    .eq("user_id", input.asker.userId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString());
  if (countError) throw countError;
  if ((count ?? 0) >= MAX_PENDING_APPROVALS) {
    throw new ApprovalError(
      429,
      `This account already has ${MAX_PENDING_APPROVALS} approvals waiting. Wait for them to be answered or to expire.`
    );
  }

  const spec = actionSpec(input.action);
  const requester = await requesterLabel(input.asker);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await admin
      .from("approvals")
      .insert({
        user_id: input.asker.userId,
        action: input.action,
        params: input.params as Json,
        summary: clip(spec.summary(input.params), MAX_SUMMARY),
        user_code: `${userCodePart()}-${userCodePart()}`,
        requested_by_key: input.asker.agentRegistrationId ? null : (input.asker.keyId ?? null),
        requested_by_agent: input.asker.agentRegistrationId ?? null,
        requester,
        client: input.requester.client,
        country: input.requester.country,
        network: input.requester.network,
        expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
      })
      .select(COLUMNS)
      .single();
    if (!error) return { approval: view(data as Row), requester };
    // A code already in use: draw another.
    if (error.code !== "23505") throw error;
  }
  throw new Error("Could not draw an unused approval code");
}

/** What the approval page shows about a pending approval, for its account only. */
export interface ApprovalReview {
  code: string;
  action: ApprovalAction;
  summary: string;
  details: ActionDetail[];
  /** What the page needs to answer it (the connection a Drive pick is for). */
  page: Record<string, unknown> | null;
  requester: string;
  client: string | null;
  country: string | null;
  network: NetworkMatch;
  createdAt: number;
  expiresAt: number;
}

async function pendingByCode(code: string): Promise<Row | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("approvals")
    .select(COLUMNS)
    .eq("user_code", code.trim().toUpperCase())
    .maybeSingle();
  if (error) throw error;
  const row = data as Row | null;
  if (!row || statusOf(row) !== "pending") return null;
  return row;
}

const OTHER_ACCOUNT =
  "This request is for another webhooks.cc account. Sign in as that account to answer it.";

export async function reviewApproval(
  code: string,
  userId: string,
  approverNetwork: string | null
): Promise<ApprovalReview | null> {
  const row = await pendingByCode(code);
  if (!row) return null;
  if (row.user_id !== userId) throw new ApprovalError(403, OTHER_ACCOUNT);
  const spec = actionSpec(row.action);
  return {
    code: row.user_code,
    action: row.action,
    summary: row.summary,
    details: await spec.details(row.params, row.user_id),
    page: spec.page?.(row.params) ?? null,
    requester: row.requester,
    client: row.client,
    country: row.country,
    network: compareNetworks(row.network, approverNetwork),
    createdAt: new Date(row.created_at).getTime(),
    expiresAt: new Date(row.expires_at).getTime(),
  };
}

/**
 * Takes back an approval the owner gave by mistake, while its asker has not
 * collected it yet (its key does not exist until then). Once collected,
 * there is nothing to withdraw: the key is revoked instead.
 */
export async function withdrawApproval(
  code: string,
  userId: string
): Promise<{ id: string; action: ApprovalAction; collected: boolean }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("approvals")
    .select(COLUMNS)
    .eq("user_code", code.trim().toUpperCase())
    .maybeSingle();
  if (error) throw error;
  const row = data as Row | null;
  if (!row) throw new ApprovalError(400, "This code has expired or was already answered.");
  if (row.user_id !== userId) throw new ApprovalError(403, OTHER_ACCOUNT);
  // An action that runs on approval is done once approved: nothing to take back.
  if (actionSpec(row.action).runAt !== "collect") {
    if (row.status === "completed") return { id: row.id, action: row.action, collected: true };
    throw new ApprovalError(400, "Only an approved request can be withdrawn.");
  }
  // Collected for good once its result is recorded. A completed row
  // without one is still being collected: withdrawing it then makes that
  // collection undo itself (pollApproval).
  const { data: updated, error: updateError } = await admin
    .from("approvals")
    .update({ status: "denied" })
    .eq("id", row.id)
    .or("status.eq.approved,and(status.eq.completed,result.is.null)")
    .select("id")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updated) {
    // Collected in the meantime, or never approved.
    const { data: now } = await admin.from("approvals").select("status").eq("id", row.id).single();
    if (now?.status === "completed") return { id: row.id, action: row.action, collected: true };
    throw new ApprovalError(400, "Only an approved request can be withdrawn.");
  }
  return { id: row.id, action: row.action, collected: false };
}

/**
 * The person's answer. Approving starts the asker's window to collect, or,
 * for an action that runs on approval, runs it now (its result is kept for
 * the asker to read). A failed run leaves the approval pending, so the person
 * can try again or refuse it.
 */
export async function decideApproval(
  code: string,
  userId: string,
  approve: boolean,
  /** What the person chose on the page, for the action (a picked file). */
  input?: unknown
): Promise<{
  id: string;
  action: ApprovalAction;
  done: boolean;
  /** Approved, and the browser goes on to finish it (Google's consent page). */
  browser?: boolean;
  /** For an action that ran on approval: what it did, and its parameters. */
  result?: Json;
  params?: unknown;
}> {
  const row = await pendingByCode(code);
  if (!row) throw new ApprovalError(400, "This code has expired or was already answered.");
  if (row.user_id !== userId) throw new ApprovalError(403, OTHER_ACCOUNT);
  const admin = createAdminClient();
  const now = new Date();
  const spec = actionSpec(row.action);
  const runsNow = approve && spec.runAt === "approve";
  const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
  const { data, error } = await admin
    .from("approvals")
    .update(
      !approve
        ? { status: "denied", decided_at: now.toISOString() }
        : runsNow
          ? {
              status: "completed",
              decided_at: now.toISOString(),
              completed_at: now.toISOString(),
              expires_at: expiresAt,
            }
          : { status: "approved", decided_at: now.toISOString(), expires_at: expiresAt }
    )
    .eq("id", row.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ApprovalError(400, "This code has expired or was already answered.");
  if (!runsNow) {
    return {
      id: row.id,
      action: row.action,
      done: false,
      browser: approve && spec.runAt === "browser",
    };
  }

  let stored: Json;
  try {
    ({ stored } = await spec.run(row.user_id, row.params, input));
  } catch (err) {
    // Only a clean refusal (ActionError: checked, nothing done) gives the
    // approval back to approve again. Anything else may have failed after
    // the action took effect (a timeout once the write landed), and
    // approving again would run it twice: the row stays completed without
    // a result, and the asker's poll ends at expiry.
    if (!(err instanceof ActionError)) throw err;
    await admin
      .from("approvals")
      .update({
        status: "pending",
        decided_at: null,
        completed_at: null,
        expires_at: row.expires_at,
      })
      .eq("id", row.id)
      .eq("status", "completed");
    throw new ApprovalError(err.status, err.message);
  }
  // The action is done whatever happens next, so the row never goes back
  // to pending from here: approving again would run it twice (a second
  // share link). A result that cannot be recorded leaves the asker's poll
  // at "approved" until the row expires, then "expired".
  let recordError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    ({ error: recordError } = await admin
      .from("approvals")
      .update({ result: stored })
      .eq("id", row.id));
    if (!recordError) break;
  }
  // Done all the same: the person is told so and the trail records it; only
  // the asker misses the result (its poll ends at expiry).
  if (recordError) reportError("Recording an approval's result failed", recordError);
  return { id: row.id, action: row.action, done: true, result: stored, params: row.params };
}

/**
 * The asker's poll. Once approved, the first poll runs the action and hands
 * over its result; the approval is then completed, and later polls see only
 * that. Only the registration or key that asked may poll; anyone else gets
 * null (a 404), whatever the id.
 */
export async function pollApproval(
  id: string,
  asker: Asker
): Promise<{ approval: ApprovalView; result?: Record<string, unknown> } | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("approvals")
    .select(COLUMNS)
    .eq("id", id)
    .eq("user_id", asker.userId)
    .maybeSingle();
  if (error) throw error;
  const row = data as Row | null;
  if (!row) return null;
  const mine = row.requested_by_agent
    ? row.requested_by_agent === asker.agentRegistrationId
    : row.requested_by_key !== null && row.requested_by_key === asker.keyId;
  if (!mine) return null;

  const runAt = actionSpec(row.action).runAt;
  // Finished in the person's browser (Google): nothing for a poll to run.
  if (runAt === "browser" && row.status !== "completed") return { approval: view(row) };
  // An action that ran on approval: its result is kept, and read as often
  // as asked until the row expires.
  if (row.status === "completed" && runAt !== "collect") {
    if (row.result !== null) {
      return { approval: view(row), result: row.result as Record<string, unknown> };
    }
    // Still running, or it ran and its result was never recorded (a crash):
    // the asker stops waiting when the row expires.
    const expired = new Date(row.expires_at).getTime() <= Date.now();
    return { approval: { ...view(row), status: expired ? "expired" : "approved" } };
  }
  if (statusOf(row) !== "approved") return { approval: view(row) };

  // Claim the collection, so two polls at once cannot both run the action.
  const { data: claimed, error: claimError } = await admin
    .from("approvals")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "approved")
    .select(COLUMNS)
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return pollApproval(id, asker);

  const spec = actionSpec(row.action);
  let ran: { result: Record<string, unknown>; stored: Json };
  try {
    ran = await spec.run(row.user_id, row.params);
  } catch (err) {
    // Give the approval back, so the asker can try again in its window
    // (after freeing a key slot, say).
    await admin
      .from("approvals")
      .update({ status: "approved", completed_at: null })
      .eq("id", row.id)
      .eq("status", "completed");
    throw err;
  }

  // Record the result, unless the owner withdrew while it ran: then take
  // the action back (a new key is deleted before anyone sees it).
  const { data: recorded, error: recordError } = await admin
    .from("approvals")
    .update({ result: ran.stored })
    .eq("id", row.id)
    .eq("status", "completed")
    .select("id")
    .maybeSingle();
  if (recordError || !recorded) {
    await spec.undo?.(row.user_id, ran.stored);
    if (recordError) throw recordError;
    throw new ApprovalError(410, "The account's owner withdrew this approval.");
  }
  return { approval: view(claimed as Row), result: ran.result };
}

/**
 * Finishes an approval the person's browser carried on with (a Google
 * connection): approved to completed, with its result for the asker. False
 * when it is no longer approved (refused, withdrawn or gone meanwhile).
 */
export async function completeBrowserApproval(
  id: string,
  userId: string,
  result: Json
): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("approvals")
    .update({ status: "completed", completed_at: new Date().toISOString(), result })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("status", "approved")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/**
 * The browser came back without finishing it (cancelled at Google, or it
 * failed): the approval waits again, so the person can try once more.
 */
export async function reopenBrowserApproval(id: string, userId: string): Promise<void> {
  const { error } = await createAdminClient()
    .from("approvals")
    .update({ status: "pending", decided_at: null })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("status", "approved");
  if (error) throw error;
}

/** The account's owner, when they asked to hear of every approval. */
export async function approvalEmailRecipient(userId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("users")
    .select("email, approval_emails")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.approval_emails && data.email ? data.email : null;
}
