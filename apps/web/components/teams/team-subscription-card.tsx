"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { UsageDisplay } from "@/components/billing/usage-display";
import type { AccountProfile } from "@/lib/account-profile";
import type { Team } from "@/lib/supabase/teams-types";
import { trackTeamSubscribeClicked } from "@/lib/analytics";
import {
  cancelTeamSubscription,
  resubscribeTeamSubscription,
  startTeamCheckout,
  updateTeamSeats,
} from "@/lib/team-billing-api";
import {
  DEFAULT_TEAM_SEATS,
  MAX_TEAM_SEATS,
  MIN_TEAM_SEATS,
  clampSeats,
  formatSeatPricing,
} from "@/lib/team-pricing";

const SESSION_EXPIRED = "Your session expired. Please sign in again.";

function formatDate(millis: number | null): string {
  if (!millis) return "unknown";
  return new Date(millis).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function SeatStepper({
  seats,
  onChange,
  disabled,
  label,
}: {
  seats: number;
  onChange: (seats: number) => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange(clampSeats(seats - 1))}
          disabled={disabled || seats <= MIN_TEAM_SEATS}
          aria-label="Decrease seats"
        >
          −
        </Button>
        <Input
          type="number"
          className="w-20 text-center"
          value={seats}
          min={MIN_TEAM_SEATS}
          max={MAX_TEAM_SEATS}
          aria-label={label}
          onChange={(e) => onChange(clampSeats(Number(e.target.value)))}
          disabled={disabled}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange(clampSeats(seats + 1))}
          disabled={disabled || seats >= MAX_TEAM_SEATS}
          aria-label="Increase seats"
        >
          +
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{formatSeatPricing(seats)}</p>
    </div>
  );
}

export function TeamSubscriptionCard({
  team,
  isOwner,
  accessToken,
  onChanged,
}: {
  team: Team;
  isOwner: boolean;
  accessToken: string | null;
  onChanged?: () => Promise<void> | void;
}) {
  const [checkoutSeats, setCheckoutSeats] = useState(DEFAULT_TEAM_SEATS);
  const [seatDraft, setSeatDraft] = useState(() => clampSeats(team.seats));
  const [subscribing, setSubscribing] = useState(false);
  const [savingSeats, setSavingSeats] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [resubscribing, setResubscribing] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleSubscribe = async () => {
    if (!accessToken) {
      setError(SESSION_EXPIRED);
      return;
    }

    setSubscribing(true);
    setError(null);
    trackTeamSubscribeClicked(checkoutSeats);
    try {
      const url = await startTeamCheckout(accessToken, team.id, checkoutSeats);
      // Reset if the redirect never happens (e.g. a popup blocker eats it).
      setTimeout(() => {
        setSubscribing(false);
        setError("Redirect failed. Please try again or check your popup blocker.");
      }, 5000);
      window.location.href = url;
    } catch (err) {
      console.error("Team checkout error:", err);
      setError(err instanceof Error ? err.message : "Failed to start checkout. Please try again.");
      setSubscribing(false);
    }
  };

  const handleUpdateSeats = async () => {
    if (!accessToken) {
      setError(SESSION_EXPIRED);
      return;
    }

    setSavingSeats(true);
    setError(null);
    setNotice(null);
    try {
      await updateTeamSeats(accessToken, team.id, seatDraft);
      setNotice(`Seats updated to ${seatDraft}.`);
      await onChanged?.();
    } catch (err) {
      console.error("Team seat update error:", err);
      setError(err instanceof Error ? err.message : "Failed to update seats. Please try again.");
    } finally {
      setSavingSeats(false);
    }
  };

  const handleConfirmCancel = async () => {
    if (!accessToken) {
      setError(SESSION_EXPIRED);
      return;
    }

    setCanceling(true);
    setError(null);
    setNotice(null);
    try {
      await cancelTeamSubscription(accessToken, team.id);
      setConfirmCancelOpen(false);
      await onChanged?.();
    } catch (err) {
      console.error("Team cancel error:", err);
      setConfirmCancelOpen(false);
      setError(
        err instanceof Error ? err.message : "Failed to cancel subscription. Please try again."
      );
    } finally {
      setCanceling(false);
    }
  };

  const handleResubscribe = async () => {
    if (!accessToken) {
      setError(SESSION_EXPIRED);
      return;
    }

    setResubscribing(true);
    setError(null);
    setNotice(null);
    try {
      await resubscribeTeamSubscription(accessToken, team.id);
      await onChanged?.();
    } catch (err) {
      console.error("Team resubscribe error:", err);
      setError(
        err instanceof Error ? err.message : "Failed to reactivate subscription. Please try again."
      );
    } finally {
      setResubscribing(false);
    }
  };

  const errorLine = error ? (
    <p className="text-sm text-destructive" role="alert" aria-live="polite">
      {error}
    </p>
  ) : null;

  // ── Unsubscribed ───────────────────────────────────────────────
  if (!team.subscriptionStatus) {
    return (
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Subscription</h2>
        <div className="border rounded-lg p-6 bg-card space-y-4">
          {isOwner ? (
            <>
              <div className="space-y-1">
                <p className="font-medium">No active subscription</p>
                <p className="text-sm text-muted-foreground">
                  Subscribe to activate this team. Every seat adds 100,000 requests to the shared
                  monthly pool, and members need a seat to access shared endpoints.
                </p>
              </div>
              <SeatStepper
                seats={checkoutSeats}
                onChange={setCheckoutSeats}
                disabled={subscribing}
                label="Seats to purchase"
              />
              <Button onClick={() => void handleSubscribe()} disabled={subscribing || !accessToken}>
                {subscribing ? "Redirecting..." : "Subscribe"}
              </Button>
              {errorLine}
            </>
          ) : (
            <div className="space-y-1">
              <p className="font-medium">This team is inactive</p>
              <p className="text-sm text-muted-foreground">
                This team needs an active Teams subscription — ask the owner to subscribe.
              </p>
            </div>
          )}
        </div>
      </section>
    );
  }

  // ── Subscribed ─────────────────────────────────────────────────
  const isPastDue = team.subscriptionStatus === "past_due";
  const isCanceling = team.cancelAtPeriodEnd || team.subscriptionStatus === "canceled";
  const statusLabel = isPastDue
    ? "Payment past due"
    : isCanceling
      ? "Cancels at period end"
      : "Active";
  const periodEndLabel = formatDate(team.periodEnd);

  // UsageDisplay renders an AccountProfile; the team's pooled quota is fed
  // through the same shape so both bars look and behave identically.
  const pooledUsage: AccountProfile = {
    id: team.id,
    email: "",
    name: team.name,
    image: null,
    plan: "pro",
    requests_used: team.requestsUsed,
    request_limit: team.requestLimit,
    period_end: team.periodEnd ? new Date(team.periodEnd).toISOString() : null,
    cancel_at_period_end: team.cancelAtPeriodEnd,
    subscription_status: team.subscriptionStatus,
  };

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Subscription</h2>
      <div className="border rounded-lg p-6 bg-card space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <p className="font-medium">Teams</p>
            <Badge
              variant="outline"
              className={
                isPastDue
                  ? "text-destructive border-destructive/50"
                  : isCanceling
                    ? "text-yellow-600 border-yellow-500/50"
                    : ""
              }
            >
              {statusLabel}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {team.memberCount} / {team.seats} {team.seats === 1 ? "seat" : "seats"}
          </p>
        </div>

        {isPastDue && (
          <p className="text-sm text-muted-foreground">
            The last payment failed. Update your payment method in the Polar receipt email to keep
            this team active.
          </p>
        )}
        {isCanceling && !isPastDue && (
          <p className="text-sm text-muted-foreground">
            This subscription ends on {periodEndLabel}. Members lose access to shared endpoints
            after that date.
          </p>
        )}

        <UsageDisplay profile={pooledUsage} />

        {isOwner && (
          <div className="pt-4 border-t space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">Seats</p>
              <SeatStepper
                seats={seatDraft}
                onChange={setSeatDraft}
                disabled={savingSeats}
                label="Seat count"
              />
              <Button
                variant="outline"
                onClick={() => void handleUpdateSeats()}
                disabled={savingSeats || seatDraft === team.seats || !accessToken}
              >
                {savingSeats ? "Updating..." : "Update seats"}
              </Button>
            </div>

            {notice && <p className="text-sm text-green-600">{notice}</p>}
            {errorLine}

            {isCanceling ? (
              <Button
                onClick={() => void handleResubscribe()}
                disabled={resubscribing || !accessToken}
              >
                {resubscribing ? "Reactivating..." : "Keep subscription"}
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={() => setConfirmCancelOpen(true)}
                disabled={canceling || !accessToken}
              >
                {canceling ? "Canceling..." : "Cancel subscription"}
              </Button>
            )}
          </div>
        )}
      </div>

      <AlertDialog
        open={confirmCancelOpen}
        onOpenChange={(isOpen) => {
          if (!canceling) setConfirmCancelOpen(isOpen);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this team&apos;s subscription?</AlertDialogTitle>
            <AlertDialogDescription>
              The team stays active until {periodEndLabel}. After that, members lose access to
              shared endpoints and the team is suspended until you subscribe again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep subscription</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleConfirmCancel()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Yes, cancel
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
