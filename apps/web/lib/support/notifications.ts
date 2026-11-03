import { sendEmail } from "@/lib/email/mailer";
import { serverEnv } from "@/lib/env";
import { reportError } from "@/lib/observability";
import { siteOrigin, webhooksOrigin } from "@/lib/site";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database";
import {
  buildClosedEmail,
  buildReminderEmail,
  buildReplyEmail,
  buildStaffAlert,
  type Reply,
} from "./emails";

/**
 * Sends what support_notifications queues (migration 00087). Rows are leased
 * five minutes at a time by support_claim_notifications(), so several web
 * processes never send one twice; a failed send keeps its row for the next
 * poll, up to five tries. A user notice checks the ticket's email setting at
 * send time, so turning it off stops what is already queued. A reply notice
 * waits a minute after the reply and carries every staff reply the user has
 * not been emailed yet.
 */

type Notification = Database["public"]["Tables"]["support_notifications"]["Row"];
type Ticket = Database["public"]["Tables"]["support_tickets"]["Row"];

const POLL_MS = 20_000;
const BATCH = 20;

async function staffReplies(ticket: Ticket): Promise<{ replies: Reply[]; newest: string | null }> {
  const admin = createAdminClient();
  let query = admin
    .from("support_messages")
    .select("author_id, body, created_at")
    .eq("ticket_id", ticket.id)
    .eq("author", "staff")
    .eq("kind", "message")
    .order("created_at", { ascending: true })
    .limit(20);
  if (ticket.user_notified_at) query = query.gt("created_at", ticket.user_notified_at);
  const { data, error } = await query;
  if (error) throw error;
  const rows = data ?? [];
  const ids = [...new Set(rows.map((row) => row.author_id).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: users } = await admin.from("users").select("id, name, email").in("id", ids);
    for (const user of users ?? []) {
      names.set(user.id, user.name?.trim().split(/\s+/)[0] || "Support");
    }
  }
  return {
    replies: rows.map((row) => ({
      author: `${(row.author_id && names.get(row.author_id)) || "Support"} from support`,
      body: row.body,
    })),
    newest: rows.at(-1)?.created_at ?? null,
  };
}

async function sendOne(notification: Notification): Promise<"sent" | "skipped"> {
  const admin = createAdminClient();
  const { data: ticket, error } = await admin
    .from("support_tickets")
    .select("*")
    .eq("id", notification.ticket_id)
    .maybeSingle();
  if (error) throw error;
  if (!ticket) return "skipped";
  const { data: user, error: userError } = await admin
    .from("users")
    .select("email, plan")
    .eq("id", ticket.user_id)
    .maybeSingle();
  if (userError) throw userError;
  if (!user) return "skipped";

  if (notification.kind === "staff_new" || notification.kind === "staff_reply") {
    if (ticket.spam) return "skipped";
    await sendEmail(
      buildStaffAlert({
        to: serverEnv().SUPPORT_ALERT_EMAIL,
        kind: notification.kind,
        number: ticket.number,
        category: ticket.category,
        plan: user.plan,
        blocking: ticket.blocking,
        link: `${webhooksOrigin()}/ops/tickets/${ticket.number}`,
      })
    );
    return "sent";
  }

  if (!ticket.notify_email) return "skipped";
  const link = `${siteOrigin(ticket.site)}/support/${ticket.number}`;
  const subjectTicket = { number: ticket.number, subject: ticket.subject };

  if (notification.kind === "reminder") {
    if (ticket.status !== "open" || ticket.waiting_on !== "user") return "skipped";
    await sendEmail(
      buildReminderEmail({
        to: user.email,
        ticket: subjectTicket,
        link,
        closesAt: new Date(new Date(ticket.waiting_since).getTime() + 7 * 86_400_000),
      })
    );
    return "sent";
  }

  const { replies, newest } = await staffReplies(ticket);
  if (notification.kind === "reply" && replies.length === 0) return "skipped";
  await sendEmail(
    notification.kind === "closed"
      ? buildClosedEmail({
          to: user.email,
          ticket: subjectTicket,
          replies,
          link,
          auto: ticket.closed_by === "auto",
        })
      : buildReplyEmail({ to: user.email, ticket: subjectTicket, replies, link })
  );
  // The newest reply this email carried, not the time now: a reply written
  // while it was being sent goes out with the next notice.
  if (!newest) return "sent";
  const { error: markError } = await admin
    .from("support_tickets")
    .update({ user_notified_at: newest })
    .eq("id", ticket.id);
  if (markError) reportError("[support] marking a ticket notified failed", markError.message);
  return "sent";
}

export async function sendSupportNotifications(): Promise<{ sent: number; failed: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("support_claim_notifications", { p_limit: BATCH });
  if (error) throw error;
  let sent = 0;
  let failed = 0;
  for (const notification of data ?? []) {
    try {
      const outcome = await sendOne(notification);
      if (outcome === "sent") sent++;
      const { error: doneError } = await admin
        .from("support_notifications")
        .update({ sent_at: new Date().toISOString(), locked_until: null })
        .eq("id", notification.id);
      if (doneError) reportError("[support] marking a notice sent failed", doneError.message);
    } catch (sendError) {
      failed++;
      reportError("[support] sending a notice failed", sendError, { kind: notification.kind });
      await admin
        .from("support_notifications")
        .update({ locked_until: null, due_at: new Date(Date.now() + 5 * 60_000).toISOString() })
        .eq("id", notification.id);
    }
  }
  return { sent, failed };
}

const globalForSupport = globalThis as unknown as {
  __supportNotifier?: ReturnType<typeof setInterval>;
};

/** Starts the sender once per process. Called from instrumentation.ts. */
export function startSupportNotifier(): void {
  if (globalForSupport.__supportNotifier) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sendSupportNotifications();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A database without migration 00087 has nothing to send yet.
      if (!/support_claim_notifications|support_notifications/.test(message)) {
        reportError("[support] notification poll failed", error);
      }
    } finally {
      running = false;
    }
  };
  globalForSupport.__supportNotifier = setInterval(tick, POLL_MS);
  globalForSupport.__supportNotifier.unref();
  void tick();
}
