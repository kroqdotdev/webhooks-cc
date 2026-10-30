import {
  BLOCK_REQUESTS,
  MONTHLY_BLOCK_CENTS,
  ONE_TIME_BLOCK_CENTS,
  OVERAGE_BLOCK_CENTS,
} from "@/lib/capacity";
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

/** `$3` for whole dollars, `$0.16` otherwise. */
function dollars(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
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

/** A paragraph in both variants: text lines and the matching HTML. */
interface Paragraph {
  text: string[];
  html: string;
}

/**
 * What a paid account can do about it: extra requests, when they are offered.
 * A plan set to end can only take one-time blocks; monthly blocks and overage
 * need a plan that renews.
 */
function paidNextStep(params: {
  planEnding: boolean;
  extraRequestsOffered: boolean;
  appUrl: string;
}): Paragraph {
  const { planEnding, extraRequestsOffered, appUrl } = params;
  const extraLink = `${appUrl}/account/plan#extra-requests`;
  const blocks = BLOCK_REQUESTS.toLocaleString("en-US");

  if (!extraRequestsOffered) {
    const accountLink = `${appUrl}/account/plan`;
    return {
      text: [`Your usage this period is on your plan page:`, accountLink],
      html: `<p>Your usage this period is on your <a href="${accountLink}">plan page</a>.</p>`,
    };
  }

  if (planEnding) {
    const offer = [
      `One-time blocks keep your webhooks coming: ${blocks} requests for`,
      `${dollars(ONE_TIME_BLOCK_CENTS)} each, kept until used.`,
    ];
    return {
      text: [...offer, `Add them on your plan page:`, extraLink],
      html: `<p>${offer.join(" ")} <a href="${extraLink}">Add extra requests</a>.</p>`,
    };
  }

  const offer = [
    `Extra requests keep your webhooks coming, in blocks of ${blocks}: monthly blocks`,
    `(${dollars(MONTHLY_BLOCK_CENTS)} a month, renewed with your plan), one-time blocks ` +
      `(${dollars(ONE_TIME_BLOCK_CENTS)}, kept until used) or`,
    `overage (${dollars(OVERAGE_BLOCK_CENTS)} per ${blocks} used, billed at the end of the ` +
      `period, up to a maximum you set).`,
  ];
  return {
    text: [...offer, `Add them on your plan page:`, extraLink],
    html: `<p>${offer.join(" ")} <a href="${extraLink}">Add extra requests</a>.</p>`,
  };
}

/**
 * Builds the email sent when an account's quota runs out and the receiver
 * starts rejecting its webhooks. A free account is offered Pro and teams; a
 * paid one (which gets it at most once per billing period) is offered extra
 * requests. Pure (no I/O) so it is unit-testable; the caller sends it through
 * sendEmail(). The limit, dates and counts come from the database or env.
 * Endpoint slugs are escaped in the HTML variant anyway, since they are the
 * one value a user could have chosen.
 */
export function buildQuotaExhaustedEmail(params: {
  to: string;
  /** The period's whole allowance: the plan's requests plus recurring blocks. */
  requestLimit: number;
  periodEnd: Date;
  /** Owned endpoints billed to a team; they keep capturing and are named as unaffected. */
  teamBilledEndpoints: number;
  /** Rejected webhooks this period; omitted or empty leaves the generic copy. */
  rejections?: QuotaRejections | null;
  /** `free` when omitted. */
  plan?: string | null;
  /** A paid plan set to end at periodEnd instead of renewing. */
  planEnding?: boolean;
  /** Whether extra requests can be bought (the Polar add-on products are configured). */
  extraRequestsOffered?: boolean;
  appUrl: string;
}): EmailMessage {
  const { to, requestLimit, periodEnd, teamBilledEndpoints, rejections, appUrl } = params;
  const plan = params.plan || "free";
  const paid = plan !== "free";
  const planName = plan.charAt(0).toUpperCase() + plan.slice(1);
  const accountLink = `${appUrl}/account/plan`;
  const teamsLink = `${appUrl}/teams`;
  const limit = requestLimit.toLocaleString("en-US");
  const resetsAt = `${periodEnd.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const teamNote =
    teamBilledEndpoints > 0
      ? "Endpoints shared with a team use the team's quota and keep capturing."
      : null;
  const rejected = rejectionLines(rejections);

  const intro: string[] = !paid
    ? [
        `You have used all ${limit} requests in your current free period on webhooks.cc.`,
        `Until the period resets at ${resetsAt}, new webhooks sent to your endpoints`,
        `are rejected with HTTP 429 and are not captured.`,
      ]
    : params.planEnding
      ? [
          `You have used all ${limit} requests in your current ${planName} billing period on webhooks.cc.`,
          `For the rest of the period, which ends at ${resetsAt}, new webhooks sent to`,
          `your endpoints are rejected with HTTP 429 and are not captured.`,
        ]
      : [
          `You have used all ${limit} requests in your current ${planName} billing period on webhooks.cc.`,
          `Until the period renews at ${resetsAt}, new webhooks sent to your endpoints`,
          `are rejected with HTTP 429 and are not captured.`,
        ];

  const nextSteps: Paragraph[] = paid
    ? [
        paidNextStep({
          planEnding: params.planEnding === true,
          extraRequestsOffered: params.extraRequestsOffered === true,
          appUrl,
        }),
      ]
    : [
        {
          text: [
            `Upgrade to Pro for 100,000 requests a month and 31-day retention, $8/month:`,
            accountLink,
          ],
          html:
            `<p><a href="${accountLink}">Upgrade to Pro</a> for 100,000 requests a month ` +
            `and 31-day retention, $8/month.</p>`,
        },
        {
          text: [
            `Capturing for a company? A team gets a pooled quota of 100,000 requests per seat:`,
            teamsLink,
          ],
          html:
            `<p>Capturing for a company? A <a href="${teamsLink}">team</a> gets a pooled quota ` +
            `of 100,000 requests per seat.</p>`,
        },
      ];

  const footer = paid
    ? "We send this at most once per billing period, only when your requests run out."
    : "We send this at most once a week, only when your quota runs out.";

  return {
    to,
    subject: "Your webhooks.cc endpoints are rejecting webhooks",
    text: [
      ...intro,
      ...(teamNote ? [teamNote] : []),
      ...(rejected
        ? [
            ``,
            rejected.headline,
            ...rejected.endpoints.map((e) => `  ${e.slug}: ${e.rejected}`),
            ...(rejected.more ? [`  ${rejected.more}`] : []),
          ]
        : []),
      ...nextSteps.flatMap((step) => [``, ...step.text]),
      ``,
      footer,
    ].join("\n"),
    html: [
      `<p>${intro.join(" ")}` + (teamNote ? ` ${teamNote}` : "") + `</p>`,
      ...(rejected
        ? [
            `<p>${rejected.headline}</p>`,
            `<ul>${rejected.endpoints
              .map((e) => `<li><code>${escapeHtml(e.slug)}</code>: ${e.rejected}</li>`)
              .join("")}${rejected.more ? `<li>${rejected.more}</li>` : ""}</ul>`,
          ]
        : []),
      ...nextSteps.map((step) => step.html),
      `<p style="color:#666;font-size:12px">${footer}</p>`,
    ].join("\n"),
  };
}
