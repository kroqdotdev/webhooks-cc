import { AGENT_BUDGET_RENEWAL_NOTE } from "@/lib/billing/agent-budget-words";
import type { EmailMessage } from "./mailer";
import { formatCents } from "@/lib/team-pricing";

/**
 * The owner's notices about an agent spend budget (lib/billing/agent-budget.ts):
 * one on every spend, one when a spend's outcome is not known (the card may
 * have been charged), a short one for the reductions keys made (at most
 * one an hour, listing every reduction since the last), and one whenever
 * the budget is set or raised. Pure, so they are unit-testable.
 * They carry no action: only a link to the billing page, where the owner
 * signs in to lower or turn off the budget. Key and team names were chosen
 * by people or agents (and are cleaned before they get here), so the HTML
 * escapes them too.
 */

const RENEWAL_NOTE = AGENT_BUDGET_RENEWAL_NOTE;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function accountWords(teamName: string | null): string {
  return teamName ? `the team "${teamName}"` : "your account";
}

export interface SpendEmailParams {
  to: string;
  change: string;
  /** What Polar charges now, before tax (after account credit). */
  chargedCents: number;
  approximate: boolean;
  renewalCents: number | null;
  /** How much the next renewal rises; 0 when it does not. */
  renewalRiseCents: number;
  /** Whether the subscription renews yearly. */
  annual?: boolean;
  /**
   * Whether the rise of the next renewal counts on top of the charge now
   * (a monthly plan, or an annual one whose renewal is at most 31 days
   * away); false: the larger of the two.
   * Absent, an annual subscription counts the larger.
   */
  riseCounted?: boolean;
  /** What the change counts against the budget. */
  countedCents: number;
  key: string;
  leftCents: number;
  budgetCents: number;
  teamName: string | null;
  billingUrl: string;
}

/** Whether a spend counted the larger of its charge and its rise, rather than both. */
function countsLarger(params: SpendEmailParams): boolean {
  return typeof params.riseCounted === "boolean" ? !params.riseCounted : params.annual === true;
}

function spendFacts(params: SpendEmailParams, charged: string): string[] {
  const renews =
    params.renewalCents === null
      ? null
      : `From the next renewal it renews at ${formatCents(params.renewalCents)}${params.renewalRiseCents > 0 ? `, ${formatCents(params.renewalRiseCents)} more than before` : ""}.`;
  return [
    `Change: ${params.change}`,
    charged,
    ...(renews ? [renews] : []),
    `Counted against the agent budget: ${formatCents(params.countedCents)}, ${countsLarger(params) ? "the larger of the charge now and the rise of the next renewal, which is more than 31 days away" : "the charge now plus the rise of the next renewal"}.`,
    `Asked by: ${params.key}.`,
    `Left of the agent budget: ${formatCents(params.leftCents)} of ${formatCents(params.budgetCents)} for the last 30 days.`,
  ];
}

function amountWords(params: SpendEmailParams): string {
  return `${params.approximate ? "about " : ""}${formatCents(params.chargedCents)}`;
}

export function buildAgentBudgetSpentEmail(params: SpendEmailParams): EmailMessage {
  const amount = amountWords(params);
  const facts = spendFacts(params, `Charged now: ${amount} before tax, to the card on file.`);
  const intro = `An agent made a billing change on ${accountWords(params.teamName)} on webhooks.cc, paid from its agent budget, without asking you first.`;
  const manage = `Lower or turn off the budget on the billing page: ${params.billingUrl}`;
  return {
    to: params.to,
    kind: "agent_budget_spent",
    subject: `An agent spent ${amount} of its budget on webhooks.cc`,
    headers: { "Auto-Submitted": "auto-generated" },
    text: [intro, "", ...facts, "", RENEWAL_NOTE, "", manage].join("\n"),
    html: [
      `<p>${escapeHtml(intro)}</p>`,
      `<ul>${facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul>`,
      `<p>${escapeHtml(RENEWAL_NOTE)}</p>`,
      `<p><a href="${escapeHtml(params.billingUrl)}">Lower or turn off the budget</a> on the billing page.</p>`,
    ].join("\n"),
  };
}

/** A change asked for on the budget whose outcome is not known: the card may have been charged. */
export function buildAgentBudgetUnknownEmail(params: SpendEmailParams): EmailMessage {
  const amount = amountWords(params);
  const facts = spendFacts(
    params,
    `May have been charged: ${amount} before tax, to the card on file.`
  );
  const intro = `An agent asked for a billing change on ${accountWords(params.teamName)} on webhooks.cc, paid from its agent budget, and something failed after Polar was asked to make it. The change may have been made, and your card may have been charged.`;
  const after =
    "It stays counted against the budget for 30 days unless Polar shows it was made. You get another email if it turns out it was made.";
  const manage = `Check billing, and lower or turn off the budget, on the billing page: ${params.billingUrl}`;
  return {
    to: params.to,
    kind: "agent_budget_unknown",
    subject: `An agent's billing change may have charged ${amount} on webhooks.cc`,
    headers: { "Auto-Submitted": "auto-generated" },
    text: [intro, "", ...facts, "", after, "", manage].join("\n"),
    html: [
      `<p>${escapeHtml(intro)}</p>`,
      `<ul>${facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul>`,
      `<p>${escapeHtml(after)}</p>`,
      `<p><a href="${escapeHtml(params.billingUrl)}">Check billing</a> on the billing page.</p>`,
    ].join("\n"),
  };
}

/** One reduction a notice lists. */
export interface ReductionLine {
  change: string;
  /** What the subscription renews at after it, when known. */
  renewalCents: number | null;
  key: string;
  /** When it was made (ISO). */
  madeAt: string;
}

function reductionWhen(madeAt: string): string {
  const ms = Date.parse(madeAt);
  return Number.isFinite(ms)
    ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "";
}

/**
 * The reductions (fewer seats or monthly blocks) keys made while the budget
 * was on, since the last notice: one email at most an hour per account.
 */
export function buildAgentBudgetDecreaseEmail(params: {
  to: string;
  reductions: ReductionLine[];
  teamName: string | null;
  billingUrl: string;
}): EmailMessage {
  const several = params.reductions.length > 1;
  const intro = several
    ? `Agents made ${params.reductions.length} reductions on ${accountWords(params.teamName)} on webhooks.cc without asking you first, as the agent budget allows. Nothing was charged.`
    : `An agent made a reduction on ${accountWords(params.teamName)} on webhooks.cc without asking you first, as the agent budget allows. Nothing was charged.`;
  const items = params.reductions.map((reduction) => {
    const when = reductionWhen(reduction.madeAt);
    return [
      `Change: ${reduction.change}`,
      ...(reduction.renewalCents === null
        ? []
        : [`From the next renewal it renews at ${formatCents(reduction.renewalCents)}.`]),
      `Asked by: ${reduction.key}${when ? `, at ${when}` : ""}.`,
    ];
  });
  const batching = several ? "Reductions are gathered into one email an hour at most." : null;
  const manage = `Undo ${several ? "them" : "it"}, or turn off the budget, on the billing page: ${params.billingUrl}`;
  return {
    to: params.to,
    kind: "agent_budget_decrease",
    subject: several
      ? `Agents made ${params.reductions.length} billing reductions on webhooks.cc`
      : "An agent made a billing reduction on webhooks.cc",
    headers: { "Auto-Submitted": "auto-generated" },
    text: [
      intro,
      "",
      ...items.flatMap((facts, index) => [...facts, ...(index < items.length - 1 ? [""] : [])]),
      "",
      ...(batching ? [batching, ""] : []),
      manage,
    ].join("\n"),
    html: [
      `<p>${escapeHtml(intro)}</p>`,
      ...items.map(
        (facts) => `<ul>${facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul>`
      ),
      ...(batching ? [`<p>${escapeHtml(batching)}</p>`] : []),
      `<p><a href="${escapeHtml(params.billingUrl)}">Open the billing page</a>.</p>`,
    ].join("\n"),
  };
}

export function buildAgentBudgetSetEmail(params: {
  to: string;
  previousCents: number;
  budgetCents: number;
  teamName: string | null;
  /** "you" for a session, or who asked for the approval the owner gave. */
  by: string;
  billingUrl: string;
}): EmailMessage {
  const what =
    params.previousCents === 0
      ? `The agent budget of ${accountWords(params.teamName)} on webhooks.cc is now ${formatCents(params.budgetCents)} per 30 days (it was off).`
      : `The agent budget of ${accountWords(params.teamName)} on webhooks.cc went from ${formatCents(params.previousCents)} to ${formatCents(params.budgetCents)} per 30 days.`;
  const how = `Set by ${params.by}.`;
  const means =
    "Your API keys and agent tokens can now add seats or move to the higher monthly plan, charged to the card on file, without asking you each time, while what a change counts fits in what is left of that amount before tax: its charge now plus how much it raises the next renewal (on an annual plan whose renewal is more than 31 days away, the larger of the two), counted for 30 days or more. You get an email on every such change.";
  const notYou =
    "If you did not expect this, turn the budget off now and email support@webhooks.cc.";
  const manage = `Change it on the billing page: ${params.billingUrl}`;
  return {
    to: params.to,
    kind: "agent_budget_set",
    subject: `Agent budget set to ${formatCents(params.budgetCents)} on webhooks.cc`,
    headers: { "Auto-Submitted": "auto-generated" },
    text: [what, how, "", means, RENEWAL_NOTE, "", notYou, manage].join("\n"),
    html: [
      `<p>${escapeHtml(what)} ${escapeHtml(how)}</p>`,
      `<p>${escapeHtml(means)}</p>`,
      `<p>${escapeHtml(RENEWAL_NOTE)}</p>`,
      `<p>${escapeHtml(notYou)} <a href="${escapeHtml(params.billingUrl)}">Change it on the billing page</a>.</p>`,
    ].join("\n"),
  };
}
