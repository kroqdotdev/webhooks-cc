import type { SupportCategory, SupportEvent } from "@/lib/supabase/database";

/** Ticket topics in the order the form offers them. */
export const SUPPORT_CATEGORIES: { value: SupportCategory; label: string }[] = [
  { value: "billing", label: "Billing" },
  { value: "bug", label: "Something is broken" },
  { value: "email", label: "Email capture and parsing" },
  { value: "forwarding", label: "Forwarding" },
  { value: "account", label: "Account and sign-in" },
  { value: "idea", label: "Idea or request" },
  { value: "other", label: "Something else" },
];

export function categoryLabel(category: string): string {
  return SUPPORT_CATEGORIES.find((entry) => entry.value === category)?.label ?? "Something else";
}

export function isSupportCategory(value: unknown): value is SupportCategory {
  return SUPPORT_CATEGORIES.some((entry) => entry.value === value);
}

export const SUBJECT_MAX = 200;
export const BODY_MAX = 10_000;
export const MAX_IMAGES = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** How long staff may still view an account after the ticket that granted it closes. */
export const GRANT_DAYS_AFTER_CLOSE = 7;
/** A user reply within this many days of a close reopens the ticket. */
export const REOPEN_DAYS = 30;
/** How long one read-only view of an account lasts. */
export const VIEW_SESSION_MINUTES = 30;

/** The sentence an event line shows to the user ("you") or to staff (the person's name). */
export function eventText(
  event: SupportEvent,
  audience: "user" | "staff",
  name = "The user"
): string {
  const actor = audience === "user" ? "You" : name;
  switch (event) {
    case "access_granted":
      return `${actor} gave support access to ${audience === "user" ? "your" : "their"} account.`;
    case "access_withdrawn":
      return `${actor} withdrew support access.`;
    case "closed":
      return "The ticket was closed.";
    case "reopened":
      return "The ticket was reopened.";
    case "auto_closed":
      return "The ticket closed on its own after 7 days without an answer.";
    case "reminded":
      return audience === "user"
        ? "We reminded you that support is waiting for your answer."
        : "Reminder sent: waiting on the user for 3 days.";
  }
}

export interface SupportAttachmentView {
  id: string;
  contentType: string;
  bytes: number;
}

export interface SupportMessageView {
  id: string;
  author: "user" | "staff" | "system";
  /** Display name: the user's name or email, or the staff member's first name. */
  authorName: string | null;
  kind: "message" | "note" | "event";
  body: string;
  event: SupportEvent | null;
  createdAt: string;
  attachments: SupportAttachmentView[];
}

export interface SupportTicketSummary {
  id: string;
  number: number;
  subject: string;
  category: SupportCategory;
  status: "open" | "closed";
  waitingOn: "support" | "user";
  waitingSince: string;
  lastMessageAt: string;
  createdAt: string;
  closedAt: string | null;
  messageCount: number;
}

export interface SupportTicketDetail extends SupportTicketSummary {
  site: "webhooks" | "mailhooks";
  blocking: boolean;
  notifyEmail: boolean;
  accessGranted: boolean;
  /** Whether staff may view the account now (granted and not expired). */
  accessActive: boolean;
  /** When access ends, for a closed ticket with access granted. */
  accessEndsAt: string | null;
  /** When the ticket closes on its own if nobody answers, while it waits on the user. */
  autoCloseAt: string | null;
  /** A user reply reopens a closed ticket until this time. */
  reopenableUntil: string | null;
  endpoint: { id: string; slug: string; name: string | null } | null;
  rating: number | null;
  messages: SupportMessageView[];
}

/** When the grant of a ticket stops letting staff view the account. */
export function grantEndsAt(closedAt: string | null): string | null {
  if (!closedAt) return null;
  return new Date(new Date(closedAt).getTime() + GRANT_DAYS_AFTER_CLOSE * 86_400_000).toISOString();
}

export function grantActive(
  ticket: { access_granted: boolean; status: string; closed_at: string | null },
  now = Date.now()
): boolean {
  if (!ticket.access_granted) return false;
  if (ticket.status === "open") return true;
  const ends = grantEndsAt(ticket.closed_at);
  return ends !== null && new Date(ends).getTime() > now;
}
