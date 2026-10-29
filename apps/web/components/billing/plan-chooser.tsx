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
import { longDate } from "@/components/settings/format";

/**
 * The plan changes an account can make from where it is: a checkout for a
 * free account, a plan change for a paying one. Pro to Business monthly
 * applies now: the difference is charged for the rest of the period and the
 * extra capacity comes in the same proportion. Every other change (another
 * interval, a lower tier) waits for the renewal, and a waiting change can be
 * dropped. Each change says which before it happens.
 */

type Option = {
  plan: PaidPlan;
  interval: BillingInterval;
  label: string;
  /** Applies now (charged pro rata) or at the renewal. */
  when: "now" | "renewal";
};

function optionsFor(profile: AccountProfile): Option[] {
  const interval: BillingInterval = profile.billing_interval === "year" ? "year" : "month";
  if (profile.plan === "free") {
    return [
      { plan: "pro", interval: "month", label: "Upgrade to Pro, $8 a month", when: "now" },
      {
        plan: "business",
        interval: "month",
        label: "Upgrade to Business, $29 a month",
        when: "now",
      },
      {
        plan: "business",
        interval: "year",
        label: "Business, $290 a year",
        when: "now",
      },
    ];
  }
  if (profile.plan === "pro") {
    return [
      {
        plan: "business",
        interval: "month",
        label: "Switch to Business, $29 a month",
        when: "now",
      },
      {
        plan: "business",
        interval: "year",
        label: "Business, $290 a year, from the renewal",
        when: "renewal",
      },
    ];
  }
  // Business.
  return interval === "month"
    ? [
        { plan: "business", interval: "year", label: "Pay yearly, $290", when: "renewal" },
        { plan: "pro", interval: "month", label: "Change to Pro", when: "renewal" },
      ]
    : [
        { plan: "business", interval: "month", label: "Pay monthly", when: "renewal" },
        { plan: "pro", interval: "month", label: "Change to Pro", when: "renewal" },
      ];
}

export function PlanChooser({
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
  if (!free && profile.cancel_at_period_end) return null;
  const renewal = profile.billing_period_end ?? profile.period_end;
  const pending =
    !free && (profile.pending_plan === "pro" || profile.pending_plan === "business")
      ? {
          plan: profile.pending_plan,
          interval: profile.pending_interval === "year" ? "year" : "month",
        }
      : null;

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
      setNotice(
        result.applied === "now"
          ? `${planName(option.plan)} starts now. The full allowance starts at the renewal.`
          : `Your plan changes${renewal ? ` on ${longDate(renewal)}` : " at the renewal"}.`
      );
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The plan could not be changed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {pending ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">
            Changes to {planName(pending.plan)}
            {pending.plan === "business"
              ? `, billed ${pending.interval === "year" ? "yearly" : "monthly"}`
              : ""}
            {renewal ? ` on ${longDate(renewal)}` : " at the renewal"}.
          </p>
          <Button variant="outline" disabled={busy || !accessToken} onClick={() => void keep()}>
            {busy ? "Keeping..." : `Keep ${planName(profile.plan)}`}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {optionsFor(profile).map((option) => (
            <Button
              key={`${option.plan}-${option.interval}`}
              variant={option.plan === "business" && option.when === "now" ? "default" : "outline"}
              disabled={busy || !accessToken}
              onClick={() => (free ? void run(option) : setConfirm(option))}
            >
              {option.label}
            </Button>
          ))}
        </div>
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
                      ? " Extra parsed pages end then too; one-time page blocks stay on your account."
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
