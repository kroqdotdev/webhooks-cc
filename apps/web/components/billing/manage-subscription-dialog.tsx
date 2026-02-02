"use client";

import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "@convex/_generated/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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

export function ManageSubscriptionDialog() {
  const user = useQuery(api.users.current);
  const cancelSubscription = useAction(api.billing.cancelSubscription);
  const resubscribe = useAction(api.billing.resubscribe);
  const [open, setOpen] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [resubscribing, setResubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user || user.plan !== "pro") return null;

  const handleCancelClick = () => {
    setConfirmCancelOpen(true);
  };

  const handleConfirmCancel = async () => {
    setCanceling(true);
    setError(null);
    try {
      await cancelSubscription();
      setConfirmCancelOpen(false);
      setOpen(false);
    } catch (err) {
      console.error("Cancel error:", err);
      setConfirmCancelOpen(false);
      setError("Failed to cancel subscription. Please try again.");
    } finally {
      setCanceling(false);
    }
  };

  const handleResubscribe = async () => {
    setResubscribing(true);
    setError(null);
    try {
      await resubscribe();
    } catch (err) {
      console.error("Resubscribe error:", err);
      setError("Failed to reactivate subscription. Please try again.");
    } finally {
      setResubscribing(false);
    }
  };

  const nextPaymentDate = user.periodEnd
    ? new Date(user.periodEnd).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : "Unknown";

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!canceling && !resubscribing) setOpen(isOpen);
    }}>
      <DialogTrigger asChild>
        <Button variant="outline">Manage subscription</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage subscription</DialogTitle>
          <DialogDescription>You&apos;re on the Pro plan</DialogDescription>
        </DialogHeader>

        {!user.cancelAtPeriodEnd && (
          <div className="space-y-4 py-4">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Next payment</span>
              <span className="font-medium">{nextPaymentDate}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Amount</span>
              <span className="font-medium">$8.00/month</span>
            </div>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive mb-4" role="alert" aria-live="polite">
            {error}
          </p>
        )}

        {user.cancelAtPeriodEnd ? (
          <div className="space-y-3">
            <div className="rounded-md bg-muted p-3 text-sm">
              Your subscription will end on {nextPaymentDate}. You&apos;ll be
              downgraded to the free tier after this date.
            </div>
            <Button
              onClick={handleResubscribe}
              disabled={resubscribing}
              className="w-full"
            >
              {resubscribing ? "Reactivating..." : "Keep my subscription"}
            </Button>
          </div>
        ) : (
          <Button
            variant="destructive"
            onClick={handleCancelClick}
            disabled={canceling}
            className="w-full"
          >
            {canceling ? "Canceling..." : "Cancel subscription"}
          </Button>
        )}
      </DialogContent>

      <AlertDialog open={confirmCancelOpen} onOpenChange={(isOpen) => {
        if (!canceling) setConfirmCancelOpen(isOpen);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel subscription?</AlertDialogTitle>
            <AlertDialogDescription>
              You&apos;ll retain Pro access until your billing period ends on{" "}
              {nextPaymentDate}. After that, you&apos;ll be downgraded to the
              free tier.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep subscription</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmCancel}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Yes, cancel
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
