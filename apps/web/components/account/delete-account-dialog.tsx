"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteAccount } from "@/lib/billing-api";
import { trackAccountDeleted, resetUser } from "@/lib/analytics";
import { createClient } from "@/lib/supabase/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export function DeleteAccountDialog({ accessToken }: { accessToken: string | null }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleDelete = async () => {
    if (!accessToken) {
      setError("Your session expired. Please sign in again.");
      return;
    }

    setDeleting(true);
    setError(null);

    try {
      await deleteAccount(accessToken);
      trackAccountDeleted();
      resetUser();

      const supabase = createClient();
      await supabase.auth.signOut();
      router.push("/");
    } catch (err) {
      console.error("Delete account error:", err);
      // The API explains billing-related refusals (e.g. a subscription that
      // could not be cancelled); surface that text instead of a generic error.
      const serverMessage =
        err instanceof Error && err.message && !err.message.startsWith("Request failed")
          ? err.message
          : null;
      setError(serverMessage ?? "Failed to delete account. Please try again.");
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-3">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" disabled={deleting || !accessToken}>
            {deleting ? "Deleting..." : "Delete account"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete account?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes your account, endpoints, API keys, device codes, and stored
              requests. Any Pro subscription and the subscriptions of teams you own are cancelled
              immediately. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep account</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Yes, delete everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && (
        <p className="text-sm text-destructive" role="alert" aria-live="polite">
          {error}
        </p>
      )}
    </div>
  );
}
