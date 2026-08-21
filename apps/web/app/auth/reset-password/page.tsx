"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { AuthPageShell } from "@/components/auth/auth-page-shell";
import { PASSWORD_MIN_LENGTH } from "@/components/auth/email-password-form";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mapAuthError } from "@/lib/auth-errors";

/**
 * Completes the password recovery flow. The recovery email links to
 * /auth/confirm, which verifies the token hash and redirects here with a
 * session in cookies; the user then sets a new password with updateUser.
 * Arriving without a session (direct visit, or a link the confirm route
 * already rejected) shows the invalid-link state instead of a form.
 */
export default function ResetPasswordPage() {
  return (
    <SupabaseAuthProvider>
      <ResetPasswordContent />
    </SupabaseAuthProvider>
  );
}

function ResetPasswordContent() {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [hasMounted, setHasMounted] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => router.replace("/dashboard"), 1200);
    return () => clearTimeout(timer);
  }, [done, router]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);

    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }

    setBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        setError(mapAuthError(error));
        return;
      }
      setDone(true);
    } catch (err) {
      setError(mapAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!hasMounted || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <AuthPageShell>
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold">That reset link is invalid or has expired.</h1>
          <p className="text-muted-foreground">
            Request a new one from the sign-in page with &ldquo;Forgot password?&rdquo;.
          </p>
          <Link href="/login" className="neo-btn-outline inline-block text-sm py-2 px-4">
            Go to sign in
          </Link>
        </div>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell>
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold mb-2">Choose a new password</h1>
        <p className="text-muted-foreground">At least {PASSWORD_MIN_LENGTH} characters.</p>
      </div>

      {done ? (
        <div className="border-2 border-foreground bg-background p-4 text-sm" role="status">
          Password updated. Taking you to your dashboard...
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {error ? (
            <div
              className="text-sm text-red-500 bg-red-50 dark:bg-red-950 p-3 rounded"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              name="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
            />
          </div>

          <Button type="submit" className="w-full h-12 text-base" disabled={busy}>
            {busy ? <span className="animate-pulse">Please wait...</span> : "Update password"}
          </Button>
        </form>
      )}
    </AuthPageShell>
  );
}
