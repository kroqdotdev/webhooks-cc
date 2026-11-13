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
import { trackUpgradeClicked } from "@/lib/analytics";
import {
  changeBillingPlan,
  createBillingCheckout,
  keepBillingPlan,
  planName,
  type BillingInterval,
  type PaidPlan,
} from "@/lib/billing-api";
import type { AccountProfile } from "@/lib/account-profile";
import { longDate } from "@/lib/dates";

/**
 * The plan changes an account can make from where it is: a checkout for a
 * free account, a plan change for a paying one. Pro to Business monthly
 * applies now: the difference is charged for the rest of the period and the
 * extra capacity comes in the same proportion. Every other change (another
 * interval, a lower tier) waits for the renewal, and a waiting change can be
 * dropped. Each change says which before it happens.
 *
 * The plan page shows each change under the plan it leads to (PlanActions)
 * and what is happening (a waiting change, a notice, the confirmation) once,
 * under the plans (PlanChooserStatus); both read one usePlanChooser().
 */

type Option = {
  plan: PaidPlan;
  interval: BillingInterval;
  /** Applies now (charged pro rata) or at the renewal. */
  when: "now" | "renewal";
  /** A button, or the quieter alternative beneath it. */
  kind: "button" | "link";
  /** The one primary action on the page. */
  primary?: boolean;
  /** What the control says, under its plan's column. */
  label: React.ReactNode;
};

/** "Upgrade, $8 a month" under Pro, read as "Upgrade to Pro, $8 a month". */
function named(verb: string, plan: PaidPlan, price?: string): React.ReactNode {
  return (
    <>
      {verb}
      <span className="sr-only"> to {planName(plan)}</span>
      {price ? `, ${price}` : ""}
    </>
  );
}

function optionsFor(profile: AccountProfile): Option[] {
  const interval: BillingInterval = profile.billing_interval === "year" ? "year" : "month";
  if (profile.plan === "free") {
    return [
      {
        plan: "pro",
        interval: "month",
        when: "now",
        kind: "button",
        label: named("Upgrade", "pro", "$8 a month"),
      },
      {
        plan: "business",
        interval: "month",
        when: "now",
        kind: "button",
        primary: true,
        label: named("Upgrade", "business", "$29 a month"),
      },
      {
        plan: "business",
        interval: "year",
        when: "now",
        kind: "link",
        label: "or $290 a year",
      },
    ];
  }
  if (profile.plan === "pro") {
    return [
      {
        plan: "business",
        interval: "month",
        when: "now",
        kind: "button",
        primary: true,
        label: named("Switch", "business", "$29 a month"),
      },
      {
        plan: "business",
        interval: "year",
        when: "renewal",
        kind: "link",
        label: "or $290 a year, from the renewal",
      },
    ];
  }
  // Business.
  const change: Option = {
    plan: "pro",
    interval: "month",
    when: "renewal",
    kind: "button",
    label: "Change to Pro",
  };
  return interval === "month"
    ? [
        {
          plan: "business",
          interval: "year",
          when: "renewal",
          kind: "link",
          label: "Pay yearly, $290",
        },
        change,
      ]
    : [
        {
          plan: "business",
          interval: "month",
          when: "renewal",
          kind: "link",
          label: "Pay monthly",
        },
        change,
      ];
}

export type PlanChooserState = ReturnType<typeof usePlanChooser>;

export function usePlanChooser({
  accessToken,
  profile,
  onChanged,
}: {
  accessToken: string | null;
  profile: AccountProfile;
  onChanged?: () => Promise<void> | void;
}) {
  const [confirm, setConfirm] = useState<Option | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const free = profile.plan === "free";
  // A plan set to end has to be kept before it can change.
  const ending = !free && profile.cancel_at_period_end;
  const renewal = profile.billing_period_end ?? profile.period_end;
  const pending =
    !free && (profile.pending_plan === "pro" || profile.pending_plan === "business")
      ? {
          plan: profile.pending_plan,
          interval: profile.pending_interval === "year" ? "year" : "month",
        }
      : null;
  // A waiting change is kept or left first; the options come back after.
  const options = ending || pending ? [] : optionsFor(profile);

  const keep = async () => {
    if (!accessToken) return setError("Your session expired. Please sign in again.");
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await keepBillingPlan(accessToken);
      setNotice(`Your plan stays ${planName(profile.plan)}.`);
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The plan could not be kept.");
    } finally {
      setBusy(false);
    }
  };

  const run = async (option: Option) => {
    if (!accessToken) return setError("Your session expired. Please sign in again.");
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (free) {
        trackUpgradeClicked();
        const url = await createBillingCheckout(accessToken, option.plan, option.interval);
        window.location.assign(url);
        return;
      }
      const result = await changeBillingPlan(accessToken, option.plan, option.interval);
      setConfirm(null);
      // A change at the renewal shows as the pending line instead.
      setNotice(
        result.applied === "now"
          ? `${planName(option.plan)} starts now. The full allowance starts at the renewal.`
          : null
      );
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The plan could not be changed.");
    } finally {
      setBusy(false);
    }
  };

  // A checkout leaves at once; a plan change asks first.
  const choose = (option: Option) => (free ? void run(option) : setConfirm(option));

  return {
    profile,
    accessToken,
    options,
    ending,
    pending,
    renewal,
    busy,
    error,
    notice,
    confirm,
    setConfirm,
    keep,
    run,
    choose,
  };
}

/**
 * What can be done with one plan, for the bottom of its column: "Current
 * plan", or the change to it, with the other interval as a link beneath.
 */
export function PlanActions({
  chooser,
  plan,
  current,
}: {
  /** Null when nothing can be changed here (a staff account). */
  chooser: PlanChooserState | null;
  plan: "free" | PaidPlan;
  current: "free" | PaidPlan;
}) {
  const options = chooser?.options.filter((option) => option.plan === plan) ?? [];
  const disabled = !chooser || chooser.busy || !chooser.accessToken;
  if (plan !== current && options.length === 0) return null;
  return (
    <div className="flex flex-col items-start gap-1.5">
      {plan === current && <p className="text-sm font-medium">Current plan</p>}
      {options.map((option) =>
        option.kind === "button" ? (
          <Button
            key={`${option.plan}-${option.interval}`}
            variant={option.primary ? "default" : "outline"}
            size="sm"
            disabled={disabled}
            onClick={() => chooser?.choose(option)}
          >
            {option.label}
          </Button>
        ) : (
          <button
            key={`${option.plan}-${option.interval}`}
            type="button"
            disabled={disabled}
            onClick={() => chooser?.choose(option)}
            className="text-left text-xs underline underline-offset-2 text-muted-foreground hover:text-foreground cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          >
            {option.label}
          </button>
        )
      )}
    </div>
  );
}

/** A change waiting for the renewal, the last change's outcome, and the confirmation. */
export function PlanChooserStatus({ chooser }: { chooser: PlanChooserState }) {
  const { profile, pending, renewal, busy, notice, error, confirm, setConfirm, keep, run } =
    chooser;
  if (chooser.ending) return null;
  return (
    <div className="space-y-2">
      {pending && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">
            Changes to {planName(pending.plan)}
            {pending.plan === "business"
              ? `, billed ${pending.interval === "year" ? "yearly" : "monthly"}`
              : ""}
            {renewal ? ` on ${longDate(renewal)}` : " at the renewal"}.
          </p>
          <Button
            variant="outline"
            disabled={busy || !chooser.accessToken}
            onClick={() => void keep()}
          >
            {busy ? "Keeping..." : `Keep ${planName(profile.plan)}`}
          </Button>
        </div>
      )}
      {notice && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {notice}
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive-ink" role="alert" aria-live="polite">
          {error}
        </p>
      )}
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && !busy && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.when === "now"
                ? `Start ${planName(confirm.plan)}${confirm.interval === "year" ? ", billed yearly" : ""}?`
                : `Change to ${confirm ? planName(confirm.plan) : ""}${confirm?.plan === "business" ? `, billed ${confirm.interval === "year" ? "yearly" : "monthly"}` : ""}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.when === "now"
                ? `You are charged the difference for what is left of this period, and get ${confirm ? planName(confirm.plan) : ""}'s extra requests and parsed pages for that part of it at once. The full allowance starts at your renewal${renewal ? ` on ${longDate(renewal)}` : ""}.`
                : `It takes effect${renewal ? ` on ${longDate(renewal)}` : " at your renewal"}; until then nothing changes.${
                    profile.plan === "business" && confirm?.plan === "pro"
                      ? " Extra parsed pages and extra domains end then too, and your custom domains stop receiving mail; one-time page blocks stay on your account. Requests older than Pro's 31 days are kept one more week, then deleted."
                      : ""
                  }`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep my plan</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                if (confirm) void run(confirm);
              }}
            >
              {busy ? "Changing..." : "Change plan"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
