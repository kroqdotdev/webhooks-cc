import { sendEmail, type EmailMessage } from "@/lib/email/mailer";
import { reportError } from "@/lib/observability";
import { siteOrigin, type SiteKey } from "@/lib/site";
import { createAdminClient } from "@/lib/supabase/admin";
import { escapeHtml } from "@/lib/support/emails";

/**
 * The email a member gets when a Connect window they opened on the team page
 * binds an agent (team.idjag_connect_bound, lib/agent/org-id-jag-grant.ts).
 * The window lets the first sign-in from the issuer with the member's email
 * connect at once, with no code to compare, so the member is told what
 * connected and where to disconnect it, in case it was not their agent. A
 * failure to send is reported, never thrown: the agent already has its
 * token, and the team page lists the connection either way.
 */

export function buildConnectBoundEmail(params: {
  to: string;
  teamName: string;
  clientName: string | null;
  issuer: string;
  connectedAt: Date;
  teamUrl: string;
}): EmailMessage {
  const client = params.clientName ?? "An agent";
  const when = params.connectedAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const what =
    `${client} connected to your webhooks.cc account at ${when}, through the ` +
    `Connect you opened for ${params.issuer} on the team ${params.teamName}.`;
  const notYou =
    "If this was not your agent, disconnect it on the team page now. Its tokens stop working at once.";
  return {
    to: params.to,
    kind: "team_idjag_connect_bound",
    subject: "An agent connected to your account",
    text: `${what}\n\n${notYou}\n${params.teamUrl}`,
    html:
      `<p>${escapeHtml(what)}</p>` +
      `<p>${escapeHtml(notYou)} <a href="${escapeHtml(params.teamUrl)}">Open the team page</a>.</p>`,
    headers: { "Auto-Submitted": "auto-generated" },
  };
}

/** Emails the member; a failure is reported, never thrown. */
export async function notifyConnectBound(input: {
  userId: string;
  teamId: string | null;
  clientName: string | null;
  issuer: string;
  connectedAt?: Date;
}): Promise<void> {
  try {
    const admin = createAdminClient();
    const [user, team] = await Promise.all([
      admin.from("users").select("email, home_site").eq("id", input.userId).maybeSingle(),
      input.teamId
        ? admin.from("teams").select("name").eq("id", input.teamId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (user.error) throw user.error;
    if (team.error) throw team.error;
    if (!user.data?.email) return;
    const origin = siteOrigin((user.data.home_site ?? "webhooks") as SiteKey);
    const teamUrl = input.teamId
      ? `${origin}/teams/${encodeURIComponent(input.teamId)}#agent-sign-in`
      : `${origin}/account`;
    await sendEmail(
      buildConnectBoundEmail({
        to: user.data.email,
        teamName: team.data?.name ?? "your team",
        clientName: input.clientName,
        issuer: input.issuer,
        connectedAt: input.connectedAt ?? new Date(),
        teamUrl,
      })
    );
  } catch (error) {
    reportError("[agent] connect-bound notice failed", error);
  }
}
