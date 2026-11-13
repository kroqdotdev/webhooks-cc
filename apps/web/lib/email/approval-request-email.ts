import type { EmailMessage } from "./mailer";

/**
 * The opt-in notice of an approval someone asked for (Account, Connected
 * agents). Pure, so it is unit-testable. The summary and the requester carry
 * names an agent chose, so the HTML escapes them; the code itself is never
 * in the mail, only the link to the page that shows it, so a mail read by
 * the wrong person still needs the account's sign-in to act on.
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildApprovalRequestEmail(params: {
  to: string;
  summary: string;
  requester: string;
  url: string;
  appUrl: string;
}): EmailMessage {
  const { to, summary, requester, url, appUrl } = params;
  const settings = `${appUrl}/account/agents`;
  return {
    to,
    kind: "approval_request",
    subject: "Approval asked for on webhooks.cc",
    headers: { "Auto-Submitted": "auto-generated" },
    text: [
      `${requester} asks for your approval on webhooks.cc:`,
      ``,
      summary,
      ``,
      `Review it (and approve or refuse it) at ${url}`,
      `The request expires in 15 minutes. If you did not expect it, choose "This wasn't me" on that page.`,
      ``,
      `You get these emails because you turned them on. Turn them off under Connected agents: ${settings}`,
    ].join("\n"),
    html: [
      `<p>${escapeHtml(requester)} asks for your approval on webhooks.cc:</p>`,
      `<p><strong>${escapeHtml(summary)}</strong></p>`,
      `<p><a href="${escapeHtml(url)}">Review it</a>, and approve or refuse it. The request expires in 15 minutes. If you did not expect it, choose "This wasn't me" on that page.</p>`,
      `<p style="color:#666;font-size:12px">You get these emails because you turned them on. <a href="${escapeHtml(settings)}">Turn them off under Connected agents</a>.</p>`,
    ].join("\n"),
  };
}
