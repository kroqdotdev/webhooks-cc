import type { EmailMessage } from "./mailer";

/**
 * Builds the email sent when a free user's quota runs out and the receiver
 * starts rejecting their webhooks. Pure (no I/O) so it is unit-testable; the
 * caller sends it through sendEmail(). Every interpolated value comes from the
 * database or env, not user input, so the HTML variant needs no escaping.
 */
export function buildQuotaExhaustedEmail(params: {
  to: string;
  requestLimit: number;
  periodEnd: Date;
  /** Owned endpoints billed to a team; they keep capturing and are named as unaffected. */
  teamBilledEndpoints: number;
  appUrl: string;
}): EmailMessage {
  const { to, requestLimit, periodEnd, teamBilledEndpoints, appUrl } = params;
  const accountLink = `${appUrl}/account`;
  const teamsLink = `${appUrl}/teams`;
  const limit = requestLimit.toLocaleString("en-US");
  const resetsAt = `${periodEnd.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const teamNote =
    teamBilledEndpoints > 0
      ? "Endpoints shared with a team use the team's quota and keep capturing."
      : null;

  return {
    to,
    subject: "Your webhooks.cc endpoints are rejecting webhooks",
    text: [
      `You have used all ${limit} requests in your current free period on webhooks.cc.`,
      `Until the period resets at ${resetsAt}, new webhooks sent to your endpoints`,
      `are rejected with HTTP 429 and are not captured.`,
      ...(teamNote ? [teamNote] : []),
      ``,
      `Upgrade to Pro for 100,000 requests a month and 31-day retention, $8/month:`,
      accountLink,
      ``,
      `Capturing for a company? A team gets a pooled quota of 100,000 requests per seat:`,
      teamsLink,
      ``,
      `We send this at most once a week, only when your quota runs out.`,
    ].join("\n"),
    html: [
      `<p>You have used all ${limit} requests in your current free period on webhooks.cc. ` +
        `Until the period resets at ${resetsAt}, new webhooks sent to your endpoints ` +
        `are rejected with HTTP 429 and are not captured.` +
        (teamNote ? ` ${teamNote}` : "") +
        `</p>`,
      `<p><a href="${accountLink}">Upgrade to Pro</a> for 100,000 requests a month ` +
        `and 31-day retention, $8/month.</p>`,
      `<p>Capturing for a company? A <a href="${teamsLink}">team</a> gets a pooled quota ` +
        `of 100,000 requests per seat.</p>`,
      `<p style="color:#666;font-size:12px">We send this at most once a week, ` +
        `only when your quota runs out.</p>`,
    ].join("\n"),
  };
}
