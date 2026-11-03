import { createAdminClient } from "@/lib/supabase/admin";
import { grantActive, VIEW_SESSION_MINUTES } from "@/lib/support/shared";

/**
 * Read-only views of an account for support, opened from a ticket the user
 * gave access on (migration 00087). A view is a row in support_view_sessions
 * that lasts 30 minutes; every read checks that it is still live and that
 * the ticket's grant still holds, so a withdrawal ends it at once. Staff
 * keep their own identity throughout: nothing here signs anyone in as the
 * user, and there is no write path. Each endpoint and request opened is
 * written to support_access_log, which the user reads under Account.
 */

export class ViewError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ViewError";
  }
}

export interface ViewSession {
  id: string;
  userId: string;
  ticketId: string;
  ticketNumber: number;
  expiresAt: string;
  account: { email: string; name: string | null; homeSite: string };
}

async function log(
  session: { userId: string; ticketId: string },
  staffId: string,
  action: "view_started" | "view_endpoint" | "view_request" | "view_ended",
  targetId: string | null
): Promise<void> {
  const { error } = await createAdminClient().from("support_access_log").insert({
    user_id: session.userId,
    ticket_id: session.ticketId,
    staff_id: staffId,
    action,
    target_id: targetId,
  });
  if (error) throw error;
}

export async function startViewSession(staffId: string, ticketId: string): Promise<ViewSession> {
  const admin = createAdminClient();
  const { data: ticket, error } = await admin
    .from("support_tickets")
    .select("id, number, user_id, status, closed_at, access_granted")
    .eq("id", ticketId)
    .maybeSingle();
  if (error) throw error;
  if (!ticket) throw new ViewError("No such ticket.", 404);
  if (!grantActive(ticket)) {
    throw new ViewError("The user has not given access on this ticket.", 403);
  }
  const expiresAt = new Date(Date.now() + VIEW_SESSION_MINUTES * 60_000).toISOString();
  const { data: session, error: insertError } = await admin
    .from("support_view_sessions")
    .insert({
      staff_id: staffId,
      user_id: ticket.user_id,
      ticket_id: ticket.id,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  // Logged before anything is shown: no view without a line in the user's log.
  await log({ userId: ticket.user_id, ticketId: ticket.id }, staffId, "view_started", null);
  return (await getViewSession(staffId, session.id)) as ViewSession;
}

/** The live session, or null when it ended, expired, or its grant is gone. */
export async function getViewSession(
  staffId: string,
  sessionId: string
): Promise<ViewSession | null> {
  const admin = createAdminClient();
  const { data: session, error } = await admin
    .from("support_view_sessions")
    .select("id, staff_id, user_id, ticket_id, expires_at, ended_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw error;
  if (!session || session.staff_id !== staffId || session.ended_at) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;
  const [{ data: ticket }, { data: user }] = await Promise.all([
    admin
      .from("support_tickets")
      .select("number, status, closed_at, access_granted")
      .eq("id", session.ticket_id)
      .maybeSingle(),
    admin.from("users").select("email, name, home_site").eq("id", session.user_id).maybeSingle(),
  ]);
  if (!ticket || !grantActive(ticket) || !user) return null;
  return {
    id: session.id,
    userId: session.user_id,
    ticketId: session.ticket_id,
    ticketNumber: ticket.number,
    expiresAt: session.expires_at,
    account: { email: user.email, name: user.name, homeSite: user.home_site },
  };
}

export async function endViewSession(staffId: string, sessionId: string): Promise<void> {
  const session = await getViewSession(staffId, sessionId);
  const { error } = await createAdminClient()
    .from("support_view_sessions")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("staff_id", staffId)
    .is("ended_at", null);
  if (error) throw error;
  if (session) await log(session, staffId, "view_ended", null);
}

export async function viewEndpoints(session: ViewSession) {
  const { data, error } = await createAdminClient()
    .from("endpoints")
    .select("id, slug, name, site, created_at, request_count")
    .eq("user_id", session.userId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    site: row.site,
    requestCount: row.request_count,
  }));
}

async function ownedEndpoint(session: ViewSession, endpointId: string) {
  const { data, error } = await createAdminClient()
    .from("endpoints")
    .select("id, slug")
    .eq("id", endpointId)
    .eq("user_id", session.userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ViewError("No such endpoint in this account.", 404);
  return data;
}

interface EmailSummary {
  subject: string | null;
  from: string | null;
}

function emailSummary(email: unknown): EmailSummary | null {
  if (!email || typeof email !== "object") return null;
  const value = email as { subject?: unknown; from?: unknown };
  const from = Array.isArray(value.from)
    ? (value.from[0] as { address?: unknown } | undefined)
    : undefined;
  return {
    subject: typeof value.subject === "string" ? value.subject : null,
    from: typeof from?.address === "string" ? from.address : null,
  };
}

export async function viewRequests(staffId: string, session: ViewSession, endpointId: string) {
  const endpoint = await ownedEndpoint(session, endpointId);
  const { data, error } = await createAdminClient()
    .from("requests")
    .select("id, method, path, kind, received_at, size, content_type, email")
    .eq("endpoint_id", endpoint.id)
    .order("received_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  await log(session, staffId, "view_endpoint", endpoint.slug);
  return (data ?? []).map((row) => ({
    id: row.id,
    method: row.method,
    path: row.path,
    kind: row.kind,
    receivedAt: row.received_at,
    size: row.size,
    contentType: row.content_type,
    email: row.kind === "email" ? emailSummary(row.email) : null,
  }));
}

export async function viewRequest(staffId: string, session: ViewSession, requestId: string) {
  const { data: row, error } = await createAdminClient()
    .from("requests")
    .select(
      "id, endpoint_id, method, path, kind, received_at, size, content_type, headers, body, query_raw, email, signature_verified, signature_error"
    )
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new ViewError("No such request.", 404);
  await ownedEndpoint(session, row.endpoint_id);
  await log(session, staffId, "view_request", row.id);
  const email =
    row.kind === "email" && row.email && typeof row.email === "object" ? row.email : null;
  const emailValue = email as {
    subject?: string | null;
    from?: { address?: string; name?: string | null }[];
    to?: { address?: string }[];
    text?: string | null;
    attachments?: { filename?: string | null; contentType?: string; size?: number }[];
  } | null;
  return {
    id: row.id,
    method: row.method,
    path: row.path,
    kind: row.kind,
    receivedAt: row.received_at,
    size: row.size,
    contentType: row.content_type,
    query: row.query_raw,
    headers: row.headers,
    // Emails show their parsed text, not the raw message.
    body: row.kind === "email" ? null : row.body,
    signature:
      row.signature_verified === null
        ? null
        : { verified: row.signature_verified, error: row.signature_error },
    email: emailValue
      ? {
          subject: emailValue.subject ?? null,
          from: emailValue.from?.map((entry) => entry.address ?? "").filter(Boolean) ?? [],
          to: emailValue.to?.map((entry) => entry.address ?? "").filter(Boolean) ?? [],
          text: emailValue.text ?? null,
          attachments:
            emailValue.attachments?.map((attachment) => ({
              filename: attachment.filename ?? null,
              contentType: attachment.contentType ?? null,
              size: attachment.size ?? null,
            })) ?? [],
        }
      : null,
  };
}
