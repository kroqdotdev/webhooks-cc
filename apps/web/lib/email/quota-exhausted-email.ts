import type { QuotaRejections } from "@/lib/supabase/quota-rejections";
import type { EmailMessage } from "./mailer";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/**
 * The sentence and per-endpoint lines describing what was rejected, or null
 * when nothing was: the email goes out within minutes of the quota running
 * out, so the first send often precedes the first rejection.
 */
function rejectionLines(rejections: QuotaRejections | null | undefined): {
  headline: string;
  endpoints: { slug: string; rejected: string }[];
  more: string | null;
} | null {
  if (!rejections || rejections.total <= 0 || rejections.endpoints.length === 0) return null;

  const remaining = Math.max(0, rejections.endpointCount - rejections.endpoints.length);
  return {
    headline:
      `So far in this period ${plural(rejections.total, "webhook was", "webhooks were")} ` +
      `rejected across ${plural(rejections.endpointCount, "endpoint", "endpoints")}:`,
    endpoints: rejections.endpoints.map((endpoint) => ({
      slug: endpoint.slug,
      rejected: plural(endpoint.rejected, "rejected webhook", "rejected webhooks"),
    })),
    more: remaining > 0 ? `and ${plural(remaining, "more endpoint", "more endpoints")}` : null,
  };
}

/**
 * Builds the email sent when a free user's quota runs out and the receiver
 * starts rejecting their webhooks. Pure (no I/O) so it is unit-testable; the
 * caller sends it through sendEmail(). The limit, dates and counts come from
 * the database or env. Endpoint slugs are escaped in the HTML variant anyway,
 * since they are the one value a user could have chosen.
 */
export function buildQuotaExhaustedEmail(params: {
  to: string;
  requestLimit: number;
  periodEnd: Date;
  /** Owned endpoints billed to a team; they keep capturing and are named as unaffected. */
  teamBilledEndpoints: number;
  /** Rejected webhooks this period; omitted or empty leaves the generic copy. */
  rejections?: QuotaRejections | null;
  appUrl: string;
}): EmailMessage {
  const { to, requestLimit, periodEnd, teamBilledEndpoints, rejections, appUrl } = params;
  const accountLink = `${appUrl}/account/plan`;
  const teamsLink = `${appUrl}/teams`;
  const limit = requestLimit.toLocaleString("en-US");
  const resetsAt = `${periodEnd.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const teamNote =
    teamBilledEndpoints > 0
      ? "Endpoints shared with a team use the team's quota and keep capturing."
      : null;
  const rejected = rejectionLines(rejections);

  return {
    to,
    subject: "Your webhooks.cc endpoints are rejecting webhooks",
    text: [
      `You have used all ${limit} requests in your current free period on webhooks.cc.`,
      `Until the period resets at ${resetsAt}, new webhooks sent to your endpoints`,
      `are rejected with HTTP 429 and are not captured.`,
      ...(teamNote ? [teamNote] : []),
      ...(rejected
        ? [
            ``,
            rejected.headline,
            ...rejected.endpoints.map((e) => `  ${e.slug}: ${e.rejected}`),
            ...(rejected.more ? [`  ${rejected.more}`] : []),
          ]
        : []),
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
      ...(rejected
        ? [
            `<p>${rejected.headline}</p>`,
            `<ul>${rejected.endpoints
              .map((e) => `<li><code>${escapeHtml(e.slug)}</code>: ${e.rejected}</li>`)
              .join("")}${rejected.more ? `<li>${rejected.more}</li>` : ""}</ul>`,
          ]
        : []),
      `<p><a href="${accountLink}">Upgrade to Pro</a> for 100,000 requests a month ` +
        `and 31-day retention, $8/month.</p>`,
      `<p>Capturing for a company? A <a href="${teamsLink}">team</a> gets a pooled quota ` +
        `of 100,000 requests per seat.</p>`,
      `<p style="color:#666;font-size:12px">We send this at most once a week, ` +
        `only when your quota runs out.</p>`,
    ].join("\n"),
  };
}
