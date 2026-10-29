"use client";

import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { InlineMessage, Notice, Panel, PanelRow, StatusTag } from "@/components/settings/panel";
import type { Team } from "@/lib/supabase/teams-types";
import { trackTeamSubscribeClicked } from "@/lib/analytics";
import {
  cancelTeamSubscription,
  quoteTeamSeats,
  resubscribeTeamSubscription,
  startTeamCheckout,
  updateTeamSeats,
} from "@/lib/team-billing-api";
import {
  DEFAULT_TEAM_SEATS,
  MAX_TEAM_SEATS,
  MIN_TEAM_SEATS,
  clampSeats,
  formatCents,
  formatSeatPricing,
  type SeatChangeQuote,
} from "@/lib/team-pricing";
import { longDate } from "@/components/settings/format";

const SESSION_EXPIRED = "Your session expired. Please sign in again.";

function formatDate(millis: number | null): string {
  return millis ? longDate(millis) : "unknown";
}

function SeatStepper({
  seats,
  onChange,
  disabled,
  label,
  id,
}: {
  id?: string;
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
          <Minus className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Input
          id={id}
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
          <Plus className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{formatSeatPricing(seats)}</p>
    </div>
  );
}

export function TeamBillingPanel({
  team,
  isOwner,
  accessToken,
  onChanged,
  activating = false,
  activationTimedOut = false,
}: {
  team: Team;
  isOwner: boolean;
  accessToken: string | null;
  onChanged?: () => Promise<void> | void;
  /** Owner is back from checkout and the activating webhook has not landed yet. */
  activating?: boolean;
  /** The activation wait ran out; offer checkout again as an escape hatch. */
  activationTimedOut?: boolean;
}) {
  const [checkoutSeats, setCheckoutSeats] = useState(DEFAULT_TEAM_SEATS);
  const [seatDraft, setSeatDraft] = useState(() => clampSeats(team.seats));
  // The parent refreshes the `team` prop in place (no remount), so a seat count
  // changed elsewhere (Polar webhook, another owner session, another tab) must
  // re-seed the draft or the stepper keeps offering a stale value to submit.
  const [syncedSeats, setSyncedSeats] = useState(team.seats);
  if (syncedSeats !== team.seats) {
    setSyncedSeats(team.seats);
    setSeatDraft(clampSeats(team.seats));
  }
  const [subscribing, setSubscribing] = useState(false);
  const [savingSeats, setSavingSeats] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [resubscribing, setResubscribing] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [confirmSeatsOpen, setConfirmSeatsOpen] = useState(false);
  const [seatQuote, setSeatQuote] = useState<SeatChangeQuote | null>(null);
  const [seatQuoteError, setSeatQuoteError] = useState<string | null>(null);
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

  // The dialog shows Polar's exact amount, priced server-side when it opens.
  const openSeatConfirmation = async () => {
    if (!accessToken) {
      setError(SESSION_EXPIRED);
      return;
    }

    setSeatQuote(null);
    setSeatQuoteError(null);
    setConfirmSeatsOpen(true);
    try {
      setSeatQuote(await quoteTeamSeats(accessToken, team.id, seatDraft));
    } catch (err) {
      console.error("Team seat quote error:", err);
      setSeatQuoteError(
        err instanceof Error ? err.message : "Could not price the seat change. Please try again."
      );
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
      setConfirmSeatsOpen(false);
      if (seatDraft < team.seats) {
        // The seat count itself only changes at renewal, so put the stepper
        // back on the seats the team still has.
        setNotice(
          `Seats drop to ${seatDraft} on ${formatDate(team.periodEnd)}. You keep ${team.seats} seats until then.`
        );
        setSeatDraft(team.seats);
      } else {
        setNotice(`Seats updated to ${seatDraft}.`);
      }
      await onChanged?.();
    } catch (err) {
      console.error("Team seat update error:", err);
      setConfirmSeatsOpen(false);
      setError(err instanceof Error ? err.message : "Failed to update seats. Please try again.");
    } finally {
      setSavingSeats(false);
    }
  };

  // Undoing a scheduled reduction costs nothing, so it needs no confirmation.
  const handleKeepSeats = async () => {
    if (!accessToken) {
      setError(SESSION_EXPIRED);
      return;
    }

    setSavingSeats(true);
    setError(null);
    setNotice(null);
    try {
      await updateTeamSeats(accessToken, team.id, team.seats);
      setSeatDraft(team.seats);
      setNotice(`Scheduled reduction cancelled. You keep ${team.seats} seats.`);
      await onChanged?.();
    } catch (err) {
      console.error("Team seat reduction cancel error:", err);
      setError(err instanceof Error ? err.message : "Failed to keep your seats. Please try again.");
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
      setNotice("Subscription kept. It renews at the end of the period.");
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

  // ── Unsubscribed ───────────────────────────────────────────────
  if (!team.subscriptionStatus) {
    if (!isOwner) {
      return (
        <Notice tone="warning" title="This team is inactive">
          This team needs an active Teams subscription. Ask the owner to subscribe.
        </Notice>
      );
    }

    if (activating) {
      return (
        <Notice tone="info" title="Activating your subscription...">
          Payment received. Polar is confirming the subscription and this page updates by itself, so
          there is no need to pay again.
        </Notice>
      );
    }

    return (
      <Panel
        id="subscribe"
        title="No active subscription"
        description="Subscribe to activate this team. Every seat adds 100,000 requests to the shared monthly pool, and members need a seat to reach shared endpoints."
        footer={
          <>
            <Button onClick={() => void handleSubscribe()} disabled={subscribing || !accessToken}>
              {subscribing ? "Redirecting..." : "Subscribe"}
            </Button>
            {error && <InlineMessage tone="error">{error}</InlineMessage>}
          </>
        }
      >
        {activationTimedOut && (
          <div className="mb-4">
            <Notice tone="warning" title="Confirmation is taking longer than expected">
              Refresh the page in a minute. Only subscribe again if your Polar receipt shows no
              charge.
            </Notice>
          </div>
        )}
        <PanelRow label="Seats" htmlFor="checkout-seats">
          <SeatStepper
            seats={checkoutSeats}
            onChange={setCheckoutSeats}
            disabled={subscribing}
            label="Seats to purchase"
            id="checkout-seats"
          />
        </PanelRow>
      </Panel>
    );
  }

  // ── Subscribed ─────────────────────────────────────────────────
  const isPastDue = team.subscriptionStatus === "past_due";
  // `subscription.canceled` writes cancel_at_period_end and the status together,
  // but resubscribing only clears the flag; the status stays "canceled" until
  // the `subscription.uncanceled` webhook lands. Keying on the flag alone keeps
  // a successful reactivation from still reading as "Cancels at period end".
  const isCanceling = team.cancelAtPeriodEnd;
  const periodEndLabel = formatDate(team.periodEnd);
  const seatDelta = seatDraft - team.seats;
  const addingSeats = seatDelta > 0;
  const seatChangeCount = Math.abs(seatDelta);
  const seatChangeNoun = seatChangeCount === 1 ? "seat" : "seats";

  const scheduledReduction =
    team.pendingSeats !== null && team.pendingSeats < team.seats ? team.pendingSeats : null;

  let seatQuoteText: string | null = null;
  if (seatQuote) {
    const renewsOn = formatDate(Date.parse(seatQuote.periodEnd));
    const renewal = `From ${renewsOn} the subscription renews at ${formatSeatPricing(seatQuote.newSeats)}. VAT is included where it applies.`;
    const amount = formatCents(seatQuote.prorationCents);
    const pending =
      seatQuote.pendingSeats !== null && seatQuote.pendingSeats < seatQuote.currentSeats
        ? seatQuote.pendingSeats
        : null;
    if (seatQuote.appliesAtRenewal) {
      seatQuoteText = `You keep ${seatQuote.currentSeats} seats until ${renewsOn}, so nothing is charged or credited now. ${renewal}${pending !== null ? ` This replaces the scheduled reduction to ${pending} seats.` : ""}`;
    } else if (seatQuote.creditAppliedCents === 0) {
      seatQuoteText = `Your card is charged ${formatCents(seatQuote.dueNowCents)} now for the rest of this billing period. ${renewal}`;
    } else if (seatQuote.dueNowCents === 0) {
      seatQuoteText = `The rest of this billing period costs ${amount}, fully covered by your account credit, so your card is not charged. ${renewal}`;
    } else {
      seatQuoteText = `The rest of this billing period costs ${amount}. ${formatCents(seatQuote.creditAppliedCents)} of account credit covers part of it, so your card is charged ${formatCents(seatQuote.dueNowCents)} now. ${renewal}`;
    }
    if (!seatQuote.appliesAtRenewal && pending !== null) {
      seatQuoteText += ` This also cancels the scheduled reduction to ${pending} seats.`;
    }
  }

  const status = isPastDue ? (
    <StatusTag tone="danger">Payment past due</StatusTag>
  ) : isCanceling ? (
    <StatusTag tone="warning">Cancels at period end</StatusTag>
  ) : (
    <StatusTag tone="success">Active</StatusTag>
  );

  return (
    <>
      <Panel
        id="billing"
        title="Billing"
        footer={
          isOwner ? (
            <>
              {isCanceling ? (
                <Button
                  onClick={() => void handleResubscribe()}
                  disabled={resubscribing || !accessToken}
                >
                  {resubscribing ? "Keeping..." : "Keep subscription"}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmCancelOpen(true)}
                  disabled={canceling || !accessToken}
                >
                  {canceling ? "Cancelling..." : "Cancel subscription"}
                </Button>
              )}
              {notice && <InlineMessage tone="success">{notice}</InlineMessage>}
              {error && <InlineMessage tone="error">{error}</InlineMessage>}
            </>
          ) : undefined
        }
      >
        <PanelRow label="Status">
          <div className="space-y-2 py-1">
            {status}
            {isPastDue && (
              <p className="text-muted-foreground">
                The last payment failed. Update the payment method from the Polar receipt email to
                keep this team active.
              </p>
            )}
            {isCanceling && !isPastDue && (
              <p className="text-muted-foreground">
                Ends on {periodEndLabel}. Members lose access to shared endpoints after that.
              </p>
            )}
            {!isCanceling && !isPastDue && team.periodEnd && (
              <p className="text-muted-foreground">
                Renews on {periodEndLabel} at {formatSeatPricing(scheduledReduction ?? team.seats)}
                {team.business ? ", plus Team Business at $49/mo" : ""}.
              </p>
            )}
          </div>
        </PanelRow>

        <PanelRow
          label="Seats"
          htmlFor={isOwner ? "seat-count" : undefined}
          hint={`${team.memberCount} of ${team.seats} in use`}
        >
          {isOwner ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-start gap-3">
                <SeatStepper
                  seats={seatDraft}
                  onChange={setSeatDraft}
                  disabled={savingSeats}
                  label="Seat count"
                  id="seat-count"
                />
                <Button
                  variant="outline"
                  onClick={() => void openSeatConfirmation()}
                  disabled={savingSeats || seatDraft === team.seats || !accessToken}
                >
                  {savingSeats ? "Updating..." : "Update seats"}
                </Button>
              </div>
              {scheduledReduction !== null && (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-muted-foreground">
                    Drops from {team.seats} to {scheduledReduction} seats on {periodEndLabel}.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleKeepSeats()}
                    disabled={savingSeats || !accessToken}
                  >
                    Keep {team.seats} seats
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <p className="py-1">
              {team.seats} {team.seats === 1 ? "seat" : "seats"}
              {scheduledReduction !== null && (
                <span className="text-muted-foreground">
                  , dropping to {scheduledReduction} on {periodEndLabel}
                </span>
              )}
            </p>
          )}
        </PanelRow>
      </Panel>

      <AlertDialog
        open={confirmSeatsOpen}
        onOpenChange={(isOpen) => {
          if (!savingSeats) setConfirmSeatsOpen(isOpen);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {addingSeats
                ? `Add ${seatChangeCount} ${seatChangeNoun}?`
                : `Remove ${seatChangeCount} ${seatChangeNoun} at renewal?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {seatQuoteError
                ? seatQuoteError
                : (seatQuoteText ?? "Calculating the exact amount...")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={savingSeats}>
              Keep {team.seats} {team.seats === 1 ? "seat" : "seats"}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // Stay open until the request settles so a decline shows in context.
                event.preventDefault();
                void handleUpdateSeats();
              }}
              disabled={savingSeats || seatQuote === null}
            >
              {savingSeats
                ? "Updating..."
                : addingSeats
                  ? seatQuote && seatQuote.dueNowCents > 0
                    ? `Pay ${formatCents(seatQuote.dueNowCents)} and add ${seatChangeNoun}`
                    : `Add ${seatChangeNoun}`
                  : `Remove at renewal`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
              Cancel subscription
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
