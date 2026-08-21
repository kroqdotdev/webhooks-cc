"use client";

import { useState, type FormEvent } from "react";
import { isAuthError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trackSignInStarted } from "@/lib/analytics";
import { mapAuthError } from "@/lib/auth-errors";

export type EmailPasswordMode = "sign-in" | "sign-up" | "forgot";

/** Mirrors GOTRUE_PASSWORD_MIN_LENGTH on the Supabase instance. */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * Email/password sign-in, sign-up, and forgot-password, sharing one email
 * field across modes. Sign-in never navigates on success: the module-level
 * auth store receives SIGNED_IN and the login page redirects. Sign-up and
 * forgot answer generically so the form never reveals whether an address is
 * registered.
 */
export function EmailPasswordForm({
  initialMode = "sign-in",
  redirectTo = "/dashboard",
}: {
  initialMode?: EmailPasswordMode;
  /** Sanitized same-origin path the login page will land on after sign-in. */
  redirectTo?: string;
}) {
  const [mode, setMode] = useState<EmailPasswordMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [canResend, setCanResend] = useState(false);

  // Sign-up confirmation happens out of band (email link, possibly another
  // browser), so the login page's ?redirect= travels with it: GoTrue renders
  // emailRedirectTo as redirect_to in the confirmation link and /auth/confirm
  // lands there. Sign-in needs nothing: the page redirects on SIGNED_IN.
  const emailRedirectTo = () => `${window.location.origin}${redirectTo}`;

  const switchMode = (next: EmailPasswordMode) => {
    setMode(next);
    setError(null);
    setNotice(null);
    setDone(null);
    setCanResend(false);
    setPassword("");
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    setCanResend(false);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError("Enter your email address");
      return;
    }
    if (mode !== "forgot" && password.length < PASSWORD_MIN_LENGTH) {
      setError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
      return;
    }

    setBusy(true);
    try {
      const supabase = createClient();

      if (mode === "sign-in") {
        trackSignInStarted("email");
        const { error } = await supabase.auth.signInWithPassword({
          email: trimmedEmail,
          password,
        });
        if (error) {
          setError(mapAuthError(error));
          setCanResend(isAuthError(error) && error.code === "email_not_confirmed");
        }
        // On success the auth store picks up SIGNED_IN and the page redirects.
        return;
      }

      if (mode === "sign-up") {
        const { error } = await supabase.auth.signUp({
          email: trimmedEmail,
          password,
          options: { emailRedirectTo: emailRedirectTo() },
        });
        if (error) {
          setError(mapAuthError(error));
          return;
        }
        // An already-registered address yields an obfuscated success (empty
        // identities) when GoTrue is configured to hide it; both cases get the
        // same generic message so the form never confirms an address exists.
        setDone(`Check your email. We sent a confirmation link to ${trimmedEmail}.`);
        return;
      }

      const { error } = await supabase.auth.resetPasswordForEmail(trimmedEmail);
      if (error) {
        setError(mapAuthError(error));
        return;
      }
      setDone(`If an account exists for ${trimmedEmail}, a reset link is on its way.`);
    } catch (err) {
      setError(mapAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleResend = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: email.trim(),
        options: { emailRedirectTo: emailRedirectTo() },
      });
      if (error) {
        setError(mapAuthError(error));
        return;
      }
      setCanResend(false);
      setNotice(`Confirmation email sent to ${email.trim()}. Check your inbox.`);
    } catch (err) {
      setError(mapAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="space-y-4" role="status" aria-live="polite">
        <div className="border-2 border-foreground bg-background p-4 text-sm">{done}</div>
        <button
          type="button"
          onClick={() => switchMode("sign-in")}
          className="text-sm underline text-muted-foreground hover:text-foreground"
        >
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {mode === "sign-up" ? (
        <h2 className="text-base font-semibold">Create an account</h2>
      ) : mode === "forgot" ? (
        <h2 className="text-base font-semibold">Reset your password</h2>
      ) : null}

      {error ? (
        <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950 p-3 rounded" role="alert">
          <p>{error}</p>
          {canResend ? (
            <button
              type="button"
              onClick={() => void handleResend()}
              disabled={busy}
              className="mt-2 underline font-medium disabled:opacity-50"
            >
              Resend confirmation email
            </button>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <div className="text-sm border-2 border-foreground bg-background p-3" role="status">
          {notice}
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="auth-email">Email</Label>
        <Input
          id="auth-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
      </div>

      {mode !== "forgot" ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="auth-password">Password</Label>
            {mode === "sign-in" ? (
              <button
                type="button"
                onClick={() => switchMode("forgot")}
                className="text-xs underline text-muted-foreground hover:text-foreground"
              >
                Forgot password?
              </button>
            ) : null}
          </div>
          <Input
            id="auth-password"
            name="password"
            type="password"
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            required
            minLength={PASSWORD_MIN_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          {mode === "sign-up" ? (
            <p className="text-xs text-muted-foreground">
              At least {PASSWORD_MIN_LENGTH} characters.
            </p>
          ) : null}
        </div>
      ) : null}

      <Button type="submit" className="w-full h-12 text-base" disabled={busy}>
        {busy ? (
          <span className="animate-pulse">Please wait...</span>
        ) : mode === "sign-in" ? (
          "Sign in"
        ) : mode === "sign-up" ? (
          "Create account"
        ) : (
          "Send reset link"
        )}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        {mode === "sign-in" ? (
          <>
            New here?{" "}
            <button
              type="button"
              onClick={() => switchMode("sign-up")}
              className="underline hover:text-foreground"
            >
              Create an account
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => switchMode("sign-in")}
            className="underline hover:text-foreground"
          >
            Back to sign in
          </button>
        )}
      </p>
    </form>
  );
}
