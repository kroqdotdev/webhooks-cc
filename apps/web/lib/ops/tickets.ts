import { createAdminClient } from "@/lib/supabase/admin";
import { categoryLabel, grantActive } from "@/lib/support/shared";
import { ticketDetail } from "@/lib/support/tickets";
import type { Database } from "@/lib/supabase/database";

type TicketRow = Database["public"]["Tables"]["support_tickets"]["Row"];

export type QueueView = "waiting" | "user" | "snoozed" | "closed" | "spam";

export function isQueueView(value: string | null): value is QueueView {
  return (
    value === "waiting" ||
    value === "user" ||
    value === "snoozed" ||
    value === "closed" ||
    value === "spam"
  );
}

export interface QueueItem {
  id: string;
  number: number;
  subject: string;
  category: string;
  categoryLabel: string;
  status: "open" | "closed";
  waitingOn: "support" | "user";
  waitingSince: string;
  blocking: boolean;
  site: string;
  snoozedUntil: string | null;
  lastMessageAt: string;
  user: { id: string; email: string; name: string | null; plan: string };
}

async function withUsers(rows: TicketRow[]): Promise<QueueItem[]> {
  const ids = [...new Set(rows.map((row) => row.user_id))];
  const users = new Map<string, { email: string; name: string | null; plan: string }>();
  if (ids.length > 0) {
    const { data, error } = await createAdminClient()
      .from("users")
      .select("id, email, name, plan")
      .in("id", ids);
    if (error) throw error;
    for (const user of data ?? []) users.set(user.id, user);
  }
  return rows.map((row) => {
    const user = users.get(row.user_id);
    return {
      id: row.id,
      number: row.number,
      subject: row.subject,
      category: row.category,
      categoryLabel: categoryLabel(row.category),
      status: row.status,
      waitingOn: row.waiting_on,
      waitingSince: row.waiting_since,
      blocking: row.blocking,
      site: row.site,
      snoozedUntil: row.snoozed_until,
      lastMessageAt: row.last_message_at,
      user: {
        id: row.user_id,
        email: user?.email ?? "",
        name: user?.name ?? null,
        plan: user?.plan ?? "free",
      },
    };
  });
}

/** One view of the staff inbox, oldest wait first where waiting matters. */
export async function listQueue(view: QueueView): Promise<QueueItem[]> {
  const now = new Date().toISOString();
  const admin = createAdminClient();
  let query = admin.from("support_tickets").select("*").limit(200);
  switch (view) {
    case "waiting":
      query = query
        .eq("status", "open")
        .eq("waiting_on", "support")
        .eq("spam", false)
        .or(`snoozed_until.is.null,snoozed_until.lte.${now}`)
        .order("waiting_since", { ascending: true });
      break;
    case "user":
      query = query
        .eq("status", "open")
        .eq("waiting_on", "user")
        .eq("spam", false)
        .order("waiting_since", { ascending: true });
      break;
    case "snoozed":
      query = query
        .eq("status", "open")
        .eq("spam", false)
        .gt("snoozed_until", now)
        .order("snoozed_until", { ascending: true });
      break;
    case "closed":
      query = query
        .eq("status", "closed")
        .eq("spam", false)
        .order("closed_at", { ascending: false });
      break;
    case "spam":
      query = query.eq("spam", true).order("last_message_at", { ascending: false });
      break;
  }
  const { data, error } = await query;
  if (error) throw error;
  return withUsers(data ?? []);
}

/** Counts for the nav: tickets waiting on support (not snoozed or spam). */
export async function waitingCount(): Promise<number> {
  const now = new Date().toISOString();
  const { count, error } = await createAdminClient()
    .from("support_tickets")
    .select("id", { count: "exact", head: true })
    .eq("status", "open")
    .eq("waiting_on", "support")
    .eq("spam", false)
    .or(`snoozed_until.is.null,snoozed_until.lte.${now}`);
  if (error) throw error;
  return count ?? 0;
}

/** A ticket as staff see it: notes included, with the account beside it. */
export async function staffTicket(row: TicketRow) {
  const admin = createAdminClient();
  const [detail, user, earlier] = await Promise.all([
    ticketDetail(row, "staff"),
    admin
      .from("users")
      .select(
        "id, email, name, plan, billing_interval, created_at, request_limit, requests_used, home_site"
      )
      .eq("id", row.user_id)
      .maybeSingle(),
    admin
      .from("support_tickets")
      .select("id", { count: "exact", head: true })
      .eq("user_id", row.user_id)
      .neq("id", row.id),
  ]);
  return {
    ticket: {
      ...detail,
      snoozedUntil: row.snoozed_until,
      spam: row.spam,
      context: row.context,
      ratingComment: row.rating_comment,
      categoryLabel: categoryLabel(row.category),
      accessActive: grantActive(row),
    },
    account: user.data
      ? {
          id: user.data.id,
          email: user.data.email,
          name: user.data.name,
          plan: user.data.plan,
          interval: user.data.billing_interval,
          createdAt: user.data.created_at,
          requestLimit: user.data.request_limit,
          requestsUsed: user.data.requests_used,
          homeSite: user.data.home_site,
          earlierTickets: earlier.count ?? 0,
        }
      : null,
  };
}
