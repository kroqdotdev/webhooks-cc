"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { longDate } from "@/components/settings/format";
import type { Team } from "@/lib/supabase/teams-types";
import { changeTeamPlan, keepTeamPlan, quoteTeamPlan } from "@/lib/team-billing-api";
import {
  MIN_TEAM_SEATS,
  TEAM_PLAN_OPTIONS,
  formatCents,
  formatSeatPricing,
  teamPlanLabel,
  teamSeatPriceUsd,
  type PlanChangeQuote,
  type TeamInterval,
  type TeamPlan,
} from "@/lib/team-pricing";

type Option = { plan: TeamPlan; interval: TeamInterval };

/** The team's plan now. */
export function currentTeamPlan(team: Pick<Team, "business" | "billingInterval">): Option {
  return {
    plan: team.business ? "team_business" : "team",
    interval: team.billingInterval === "year" ? "year" : "month",
  };
}

/** Up (Teams to Team Business, or monthly to annual) applies now; down at the renewal. */
function appliesNow(from: Option, to: Option): boolean {
  if (from.plan !== to.plan) return to.plan === "team_business";
  return from.interval === "month" && to.interval === "year";
}

function optionLabel(option: Option, now: boolean): string {
  const price = teamSeatPriceUsd(option.plan, option.interval);
  const per = option.interval === "year" ? "a seat a year" : "a seat a month";
  if (option.plan === "team") return `Change to Teams, $${price} ${per}`;
  if (option.interval === "year") return `Team Business yearly, $${price} ${per}`;
  return `${now ? "Upgrade to" : "Change to"} Team Business, $${price} ${per}`;
}

/**
 * The owner's plan changes for a subscribed team. Upgrades (Teams to Team
 * Business, or to annual billing) apply at once: Polar charges the
 * difference for the rest of the period (a move to annual starts a new year
 * at once), and the extra requests and pages come in the same proportion.
 * Downgrades wait for the renewal and can be undone until then.
 */
export function TeamPlanChooser({
  team,
  accessToken,
  onChanged,
}: {
  team: Team;
  accessToken: string | null;
  onChanged?: () => Promise<void> | void;
}) {
  const [confirm, setConfirm] = useState<Option | null>(null);
  const [quote, setQuote] = useState<PlanChangeQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const current = currentTeamPlan(team);
  // When a change waiting for the renewal applies: the year's end on annual billing.
  const renewal = team.billingPeriodEnd;
  const pending: Option | null =
    team.pendingPlan !== null
      ? { plan: team.pendingPlan, interval: team.pendingInterval === "year" ? "year" : "month" }
      : null;
  const options = TEAM_PLAN_OPTIONS.filter(
    (option) => option.plan !== current.plan || option.interval !== current.interval
  );
  const tooFewSeats = team.seats < MIN_TEAM_SEATS;

  const open = async (option: Option) => {
    if (!accessToken) return setError("Your session expired. Please sign in again.");
    setConfirm(option);
    setQuote(null);
    setQuoteError(null);
    try {
      setQuote(await quoteTeamPlan(accessToken, team.id, option.plan, option.interval));
    } catch (err) {
      setQuoteError(err instanceof Error ? err.message : "Could not price the change.");
    }
  };

  const run = async (option: Option) => {
    if (!accessToken) return setError("Your session expired. Please sign in again.");
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await changeTeamPlan(accessToken, team.id, option.plan, option.interval);
      setConfirm(null);
      // A change at the renewal shows as the pending line instead.
      setNotice(
        result.applied === "now"
          ? `${teamPlanLabel(option.plan, option.interval)} starts now.`
          : null
      );
      await onChanged?.();
    } catch (err) {
      setConfirm(null);
      setError(err instanceof Error ? err.message : "The plan could not be changed.");
    } finally {
      setBusy(false);
    }
  };

  const keep = async () => {
    if (!accessToken) return setError("Your session expired. Please sign in again.");
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await keepTeamPlan(accessToken, team.id);
      setNotice(`The team stays on ${teamPlanLabel(current.plan, current.interval)}.`);
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The plan could not be kept.");
    } finally {
      setBusy(false);
    }
  };

  const now = confirm !== null && appliesNow(current, confirm);
  let description = "Calculating the amount...";
  if (quoteError) {
    description = quoteError;
  } else if (confirm && quote) {
    const renews = formatSeatPricing(quote.seats, confirm.plan, confirm.interval);
    if (!now) {
      description = `It takes effect${renewal ? ` on ${longDate(renewal)}` : " at the renewal"}, and the team renews at ${renews}; until then nothing changes.${
        current.plan === "team_business" && confirm.plan === "team"
          ? " Extra parsed pages and extra domains end then too, the team's custom domain stops receiving mail, and requests older than 31 days are kept one more week, then deleted."
          : ""
      }`;
    } else if (confirm.interval === "year" && current.interval === "month") {
      description = `A new year starts today at ${renews}. The unused part of this month (about ${formatCents(quote.creditCents)}) is credited, so the card is charged about ${formatCents(quote.dueNowCents)} now, and the team's allowance starts afresh.`;
    } else {
      description = `For the rest of this period you are charged about ${formatCents(quote.chargeCents)}, less ${formatCents(quote.creditCents)} for the unused part of ${teamPlanLabel(current.plan, current.interval)}, so the card is charged about ${formatCents(quote.dueNowCents)} now. The extra requests and parsed pages for this period come in the same proportion; the full allowance starts at the renewal${renewal ? ` on ${longDate(renewal)}` : ""}, at ${renews}.`;
    }
    if (quote.creditAppliedCents > 0 && now) {
      description += ` ${formatCents(quote.creditAppliedCents)} of account credit is spent first.`;
    }
    description += " VAT is included where it applies.";
  }

  return (
    <div className="space-y-2">
      {pending ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">
            Changes to {teamPlanLabel(pending.plan, pending.interval)}
            {renewal ? ` on ${longDate(renewal)}` : " at the renewal"}.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !accessToken}
            onClick={() => void keep()}
          >
            {busy ? "Keeping..." : `Keep ${teamPlanLabel(current.plan, current.interval)}`}
          </Button>
        </div>
      ) : team.cancelAtPeriodEnd ? (
        <p className="text-sm text-muted-foreground">
          Keep the subscription to change the team&apos;s plan.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {options.map((option) => {
              const up = appliesNow(current, option);
              return (
                <Button
                  key={`${option.plan}-${option.interval}`}
                  variant={up ? "default" : "outline"}
                  size="sm"
                  disabled={
                    busy || !accessToken || (option.plan === "team_business" && tooFewSeats)
                  }
                  onClick={() => void open(option)}
                >
                  {optionLabel(option, up)}
                </Button>
              );
            })}
          </div>
          {tooFewSeats && current.plan === "team" && (
            <p className="text-sm text-muted-foreground">
              Team Business starts at {MIN_TEAM_SEATS} seats. Add a seat first, then upgrade.
            </p>
          )}
        </>
      )}
      {notice && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {notice}
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert" aria-live="polite">
          {error}
        </p>
      )}
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(isOpen) => !isOpen && !busy && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm
                ? now
                  ? `Start ${teamPlanLabel(confirm.plan, confirm.interval)} now?`
                  : `Change to ${teamPlanLabel(confirm.plan, confirm.interval)} at the renewal?`
                : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              Keep {teamPlanLabel(current.plan, current.interval)}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || quote === null}
              onClick={(event) => {
                // Stay open until the request settles so a decline shows in context.
                event.preventDefault();
                if (confirm) void run(confirm);
              }}
            >
              {busy
                ? "Changing..."
                : now && quote && quote.dueNowCents > 0
                  ? `Pay about ${formatCents(quote.dueNowCents)} and change`
                  : "Change plan"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
