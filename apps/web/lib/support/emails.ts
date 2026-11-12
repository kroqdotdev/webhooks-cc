import type { EmailMessage } from "@/lib/email/mailer";
import { categoryLabel } from "./shared";

/**
 * The emails tickets send. Pure, so they are unit-tested; the sender
 * (notifications.ts) fills in the facts. Users get the staff reply in full,
 * never their own words back, and never anything from their account. Staff
 * alerts carry no ticket contents at all, only the number, topic and plan
 * with a link. Subjects are fixed text: the ticket's own subject was
 * written by the user, and mail from our domain must not carry it.
 */

const AUTOMATIC = { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" };

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A header-safe subject line: one line, bounded. */
export function headerText(value: string, max = 120): string {
  const flat = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function paragraphsHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function layout(bodyHtml: string): string {
  return (
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;` +
    `line-height:1.55;color:#1a1f27;max-width:600px">${bodyHtml}</div>`
  );
}

interface Ticket {
  number: number;
  subject: string;
}

export interface Reply {
  author: string;
  body: string;
}

function repliesText(replies: Reply[]): string {
  return replies.map((reply) => `${reply.author} wrote:\n\n${reply.body}`).join("\n\n---\n\n");
}

function repliesHtml(replies: Reply[]): string {
  return replies
    .map(
      (reply) =>
        `<p style="color:#5b6472;margin:0 0 4px">${escapeHtml(reply.author)} wrote:</p>` +
        `<div style="border-left:3px solid #d9dee6;padding-left:12px;margin:0 0 16px">` +
        `${paragraphsHtml(reply.body)}</div>`
    )
    .join("");
}

function footer(link: string): { text: string; html: string } {
  return {
    text:
      `Answer in the dashboard, not by replying to this email: ${link}\n\n` +
      `You get these emails because you asked for updates on this ticket. ` +
      `Turn them off on the ticket.`,
    html:
      `<p><a href="${escapeHtml(link)}">Open the ticket</a> to answer. Replies to this email are not read.</p>` +
      `<p style="color:#5b6472;font-size:13px">You get these emails because you asked for updates ` +
      `on this ticket. Turn them off on the ticket.</p>`,
  };
}

export function buildReplyEmail(params: {
  to: string;
  ticket: Ticket;
  replies: Reply[];
  link: string;
}): EmailMessage {
  const { ticket, replies, link } = params;
  const end = footer(link);
  return {
    to: params.to,
    kind: "support_reply",
    subject: `[#${ticket.number}] Support replied to your ticket`,
    text: `Support answered your ticket #${ticket.number}.\n\n${repliesText(replies)}\n\n${end.text}`,
    html: layout(
      `<p>Support answered your ticket #${ticket.number}.</p>${repliesHtml(replies)}${end.html}`
    ),
    headers: AUTOMATIC,
  };
}

export function buildClosedEmail(params: {
  to: string;
  ticket: Ticket;
  replies: Reply[];
  link: string;
  auto: boolean;
}): EmailMessage {
  const { ticket, replies, link } = params;
  const why = params.auto
    ? `Your ticket #${ticket.number} closed after 7 days without an answer.`
    : `Your ticket #${ticket.number} is closed.`;
  const reopen =
    "If something is still wrong, answer on the ticket within 30 days and it opens again.";
  const rateText = [1, 2, 3, 4, 5].map((n) => `${n}: ${link}?rate=${n}`).join("\n");
  const rateHtml = [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<a href="${escapeHtml(`${link}?rate=${n}`)}" style="display:inline-block;min-width:28px;` +
        `padding:4px 8px;margin-right:4px;border:1px solid #d9dee6;border-radius:6px;` +
        `text-align:center;color:#1a1f27;text-decoration:none">${n}</a>`
    )
    .join("");
  const end = footer(link);
  return {
    to: params.to,
    kind: "support_closed",
    subject: `[#${ticket.number}] Your ticket is closed`,
    text:
      `${why}\n\n` +
      (replies.length ? `${repliesText(replies)}\n\n` : "") +
      `${reopen}\n\nHow did we do, from 1 (poor) to 5 (great)?\n${rateText}\n\n${end.text}`,
    html: layout(
      `<p>${escapeHtml(why)}</p>${repliesHtml(replies)}<p>${escapeHtml(reopen)}</p>` +
        `<p>How did we do, from 1 (poor) to 5 (great)?</p><p>${rateHtml}</p>${end.html}`
    ),
    headers: AUTOMATIC,
  };
}

export function buildReminderEmail(params: {
  to: string;
  ticket: Ticket;
  link: string;
  closesAt: Date;
}): EmailMessage {
  const { ticket, link } = params;
  const date = params.closesAt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const line =
    `Support is waiting for your answer on ticket #${ticket.number}. ` +
    `If there is nothing more, it closes on its own on ${date}.`;
  const end = footer(link);
  return {
    to: params.to,
    kind: "support_reminder",
    subject: `[#${ticket.number}] Support is waiting for your answer`,
    text: `${line}\n\n${end.text}`,
    html: layout(`<p>${escapeHtml(line)}</p>${end.html}`),
    headers: AUTOMATIC,
  };
}

/** For support@: what happened and where, without anything the user wrote. */
export function buildStaffAlert(params: {
  to: string;
  kind: "staff_new" | "staff_reply";
  number: number;
  category: string;
  plan: string;
  blocking: boolean;
  link: string;
}): EmailMessage {
  const what = params.kind === "staff_new" ? "New ticket" : "New reply on ticket";
  const topic = categoryLabel(params.category);
  const plan = params.plan.charAt(0).toUpperCase() + params.plan.slice(1);
  const urgent = params.blocking ? ", blocking" : "";
  const line = `${what} #${params.number}: ${topic}, ${plan}${urgent}.`;
  return {
    to: params.to,
    kind: "support_staff_alert",
    subject: `${what} #${params.number} (${topic}${urgent})`,
    text: `${line}\n\n${params.link}`,
    html: layout(
      `<p>${escapeHtml(line)}</p><p><a href="${escapeHtml(params.link)}">Open in operations</a></p>`
    ),
    headers: AUTOMATIC,
  };
}
