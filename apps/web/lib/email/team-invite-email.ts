import type { EmailMessage } from "./mailer";

/**
 * Builds the team invite email. Pure (no I/O) so it is unit-testable; the
 * caller sends it through sendEmail(). Team names and inviter emails are user
 * input, so the HTML variant escapes them.
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildTeamInviteEmail(params: {
  inviterEmail: string;
  teamName: string;
  invitedEmail: string;
  appUrl: string;
}): EmailMessage {
  const { inviterEmail, teamName, invitedEmail, appUrl } = params;
  const link = `${appUrl}/teams`;

  return {
    to: invitedEmail,
    subject: `${inviterEmail} invited you to ${teamName} on webhooks.cc`,
    text: [
      `${inviterEmail} invited you to join the team "${teamName}" on webhooks.cc,`,
      `a webhook inspection and testing service.`,
      ``,
      `Sign in (or create an account) with this email address (${invitedEmail})`,
      `and the invite will be waiting for you at ${link}`,
    ].join("\n"),
    html: [
      `<p>${escapeHtml(inviterEmail)} invited you to join the team ` +
        `<strong>${escapeHtml(teamName)}</strong> on webhooks.cc, ` +
        `a webhook inspection and testing service.</p>`,
      `<p>Sign in (or create an account) with this email address ` +
        `(${escapeHtml(invitedEmail)}) and the invite will be waiting for you at ` +
        `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>.</p>`,
    ].join("\n"),
  };
}
