import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database";
import { isObjectStorageConfigured, putObject } from "@/lib/storage/object-store";
import { reportError } from "@/lib/observability";
import {
  grantActive,
  grantEndsAt,
  REOPEN_DAYS,
  type SupportMessageView,
  type SupportTicketDetail,
  type SupportTicketSummary,
} from "./shared";
import type { ImageType } from "./images";

/**
 * Reads and writes for support tickets (migration 00087), with the service
 * role. Users only ever reach their own tickets, and never see notes: every
 * user-facing read filters them out here, not in the browser.
 */

type TicketRow = Database["public"]["Tables"]["support_tickets"]["Row"];
type MessageRow = Database["public"]["Tables"]["support_messages"]["Row"];
type AttachmentRow = Database["public"]["Tables"]["support_attachments"]["Row"];

const AUTO_CLOSE_DAYS = 7;

export class SupportError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "SupportError";
  }
}

export function attachmentKey(ticketId: string, attachmentId: string): string {
  return `t/${ticketId}/${attachmentId}`;
}

export function attachmentsEnabled(): boolean {
  try {
    return isObjectStorageConfigured();
  } catch {
    return false;
  }
}

function summary(row: TicketRow, messageCount: number): SupportTicketSummary {
  return {
    id: row.id,
    number: row.number,
    subject: row.subject,
    category: row.category,
    status: row.status,
    waitingOn: row.waiting_on,
    waitingSince: row.waiting_since,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    messageCount,
  };
}

async function messageCounts(ticketIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (ticketIds.length === 0) return counts;
  const { data, error } = await createAdminClient()
    .from("support_messages")
    .select("ticket_id")
    .in("ticket_id", ticketIds)
    .eq("kind", "message");
  if (error) throw error;
  for (const row of data ?? []) counts.set(row.ticket_id, (counts.get(row.ticket_id) ?? 0) + 1);
  return counts;
}

/** The user's tickets, newest activity first. */
export async function listUserTickets(userId: string): Promise<SupportTicketSummary[]> {
  const { data, error } = await createAdminClient()
    .from("support_tickets")
    .select("*")
    .eq("user_id", userId)
    .order("last_message_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  const rows = data ?? [];
  const counts = await messageCounts(rows.map((row) => row.id));
  return rows.map((row) => summary(row, counts.get(row.id) ?? 0));
}

/** A staff member's first name, or "Support": never their email address. */
function firstName(name: string | null): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed.split(/\s+/)[0] : "Support";
}

/** Messages with attachments and author names. Notes only for staff. */
async function loadMessages(
  ticket: TicketRow,
  audience: "user" | "staff"
): Promise<SupportMessageView[]> {
  const admin = createAdminClient();
  let query = admin
    .from("support_messages")
    .select("*")
    .eq("ticket_id", ticket.id)
    .order("created_at", { ascending: true });
  if (audience === "user") query = query.neq("kind", "note");
  const { data: messages, error } = await query;
  if (error) throw error;
  const rows: MessageRow[] = messages ?? [];

  const { data: attachments, error: attachmentsError } = await admin
    .from("support_attachments")
    .select("*")
    .eq("ticket_id", ticket.id);
  if (attachmentsError) throw attachmentsError;
  const byMessage = new Map<string, AttachmentRow[]>();
  for (const attachment of attachments ?? []) {
    const list = byMessage.get(attachment.message_id) ?? [];
    list.push(attachment);
    byMessage.set(attachment.message_id, list);
  }

  const authorIds = [
    ...new Set(rows.map((row) => row.author_id).filter((id): id is string => !!id)),
  ];
  const names = new Map<string, { name: string | null; email: string }>();
  if (authorIds.length > 0) {
    const { data: users, error: usersError } = await admin
      .from("users")
      .select("id, name, email")
      .in("id", authorIds);
    if (usersError) throw usersError;
    for (const user of users ?? []) names.set(user.id, { name: user.name, email: user.email });
  }

  return rows.map((row) => {
    const person = row.author_id ? names.get(row.author_id) : undefined;
    const authorName =
      row.author === "staff"
        ? firstName(person?.name ?? null)
        : row.author === "user"
          ? person?.name?.trim() || person?.email || null
          : null;
    return {
      id: row.id,
      author: row.author,
      authorName,
      kind: row.kind,
      body: row.body,
      event: row.event,
      createdAt: row.created_at,
      attachments: (byMessage.get(row.id) ?? []).map((attachment) => ({
        id: attachment.id,
        contentType: attachment.content_type,
        bytes: attachment.bytes,
      })),
    };
  });
}

async function endpointOf(endpointId: string | null) {
  if (!endpointId) return null;
  const { data } = await createAdminClient()
    .from("endpoints")
    .select("id, slug, name")
    .eq("id", endpointId)
    .maybeSingle();
  return data ? { id: data.id, slug: data.slug, name: data.name ?? null } : null;
}

export async function ticketDetail(
  row: TicketRow,
  audience: "user" | "staff"
): Promise<SupportTicketDetail> {
  const messages = await loadMessages(row, audience);
  const messageCount = messages.filter((message) => message.kind === "message").length;
  const autoCloseAt =
    row.status === "open" && row.waiting_on === "user"
      ? new Date(new Date(row.waiting_since).getTime() + AUTO_CLOSE_DAYS * 86_400_000).toISOString()
      : null;
  const reopenableUntil = row.closed_at
    ? new Date(new Date(row.closed_at).getTime() + REOPEN_DAYS * 86_400_000).toISOString()
    : null;
  return {
    ...summary(row, messageCount),
    site: row.site,
    blocking: row.blocking,
    notifyEmail: row.notify_email,
    accessGranted: row.access_granted,
    accessActive: grantActive(row),
    accessEndsAt: row.access_granted ? grantEndsAt(row.closed_at) : null,
    autoCloseAt,
    reopenableUntil,
    endpoint: await endpointOf(row.endpoint_id),
    rating: row.rating,
    messages,
  };
}

export async function userTicketRow(userId: string, number: number): Promise<TicketRow | null> {
  const { data, error } = await createAdminClient()
    .from("support_tickets")
    .select("*")
    .eq("user_id", userId)
    .eq("number", number)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function ticketRowByNumber(number: number): Promise<TicketRow | null> {
  const { data, error } = await createAdminClient()
    .from("support_tickets")
    .select("*")
    .eq("number", number)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function ticketRowById(id: string): Promise<TicketRow | null> {
  const { data, error } = await createAdminClient()
    .from("support_tickets")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export interface CleanImage {
  bytes: Buffer;
  type: ImageType;
}

/**
 * Stores screenshots for a message. has_attachments is set first, so a
 * ticket deleted while the upload runs still has its prefix cleaned up.
 * Returns how many were stored; a failed upload is reported, not thrown,
 * because the message itself is already saved.
 */
export async function storeAttachments(
  ticketId: string,
  messageId: string,
  images: CleanImage[]
): Promise<number> {
  if (images.length === 0) return 0;
  const admin = createAdminClient();
  const { error: flagError } = await admin
    .from("support_tickets")
    .update({ has_attachments: true })
    .eq("id", ticketId);
  if (flagError) {
    reportError("[support] marking attachments failed", flagError.message);
    return 0;
  }
  let stored = 0;
  for (const image of images) {
    const id = crypto.randomUUID();
    try {
      await putObject(attachmentKey(ticketId, id), image.bytes, image.type);
      const { error } = await admin.from("support_attachments").insert({
        id,
        ticket_id: ticketId,
        message_id: messageId,
        content_type: image.type,
        bytes: image.bytes.length,
      });
      if (error) throw error;
      stored++;
    } catch (error) {
      reportError("[support] storing a screenshot failed", error);
    }
  }
  return stored;
}

export interface NewTicketInput {
  userId: string;
  site: "webhooks" | "mailhooks";
  category: string;
  subject: string;
  body: string;
  blocking: boolean;
  endpointId: string | null;
  notifyEmail: boolean;
  grantAccess: boolean;
  context: Record<string, Json>;
}

export async function createTicket(
  input: NewTicketInput
): Promise<{ id: string; number: number; messageId: string }> {
  const { data, error } = await createAdminClient().rpc("support_create_ticket", {
    p_user_id: input.userId,
    p_site: input.site,
    p_category: input.category,
    p_subject: input.subject,
    p_body: input.body,
    p_blocking: input.blocking,
    p_endpoint_id: input.endpointId,
    p_notify: input.notifyEmail,
    p_grant: input.grantAccess,
    p_context: input.context,
  });
  if (error) throw error;
  const row = data?.[0];
  if (!row) throw new Error("support_create_ticket returned nothing");
  return { id: row.ticket_id, number: row.ticket_number, messageId: row.message_id };
}

/** Adds a message. Throws SupportError(409) for a ticket closed too long ago to reopen. */
export async function postMessage(input: {
  ticketId: string;
  author: "user" | "staff";
  authorId: string;
  kind: "message" | "note";
  body: string;
  close?: boolean;
}): Promise<{ messageId: string | null; status: "open" | "closed" }> {
  const { data, error } = await createAdminClient().rpc("support_post_message", {
    p_ticket_id: input.ticketId,
    p_author: input.author,
    p_author_id: input.authorId,
    p_kind: input.kind,
    p_body: input.body,
    p_close: input.close ?? false,
  });
  if (error) {
    if (error.message.includes("ticket_closed")) {
      throw new SupportError(
        `This ticket closed more than ${REOPEN_DAYS} days ago. Open a new ticket instead.`,
        409
      );
    }
    throw error;
  }
  const row = data?.[0];
  return { messageId: row?.message_id ?? null, status: row?.status ?? "open" };
}

export async function closeTicket(
  ticketId: string,
  by: "user" | "staff",
  actorId: string
): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("support_close_ticket", {
    p_ticket_id: ticketId,
    p_by: by,
    p_actor_id: actorId,
  });
  if (error) throw error;
  return data === true;
}

export async function setAccess(
  ticketId: string,
  userId: string,
  granted: boolean
): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("support_set_access", {
    p_ticket_id: ticketId,
    p_user_id: userId,
    p_granted: granted,
  });
  if (error) throw error;
  return data === true;
}

export async function updateTicket(
  ticketId: string,
  values: Database["public"]["Tables"]["support_tickets"]["Update"]
): Promise<void> {
  const { error } = await createAdminClient()
    .from("support_tickets")
    .update(values)
    .eq("id", ticketId);
  if (error) throw error;
}

/** The user's endpoints, for the form's endpoint picker. */
export async function userEndpointChoices(
  userId: string
): Promise<{ id: string; slug: string; name: string | null }[]> {
  const { data, error } = await createAdminClient()
    .from("endpoints")
    .select("id, slug, name")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []).map((row) => ({ id: row.id, slug: row.slug, name: row.name ?? null }));
}
