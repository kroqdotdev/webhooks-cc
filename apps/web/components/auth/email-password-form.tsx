"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { isAuthError } from "@supabase/supabase-js";
import { DEFAULT_EMAIL_DOMAIN } from "@webhooks-cc/sdk/email";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trackSignInStarted } from "@/lib/analytics";
import { mapAuthError } from "@/lib/auth-errors";
import { isCaptureDomainAddress } from "@/lib/email-capture";

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
  onModeChange,
}: {
  initialMode?: EmailPasswordMode;
  /** Told when the form switches mode, so the page heading can follow it. */
  onModeChange?: (mode: EmailPasswordMode) => void;
  /** Sanitized same-origin path the login page will land on after sign-in. */
  redirectTo?: string;
}) {
  const [mode, setMode] = useState<EmailPasswordMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A check the form makes itself names the field it is about: the message sits
  // under that field and focus goes there. Server answers use the alert under
  // the fields.
  const [fieldError, setFieldError] = useState<{
    field: "email" | "password";
    message: string;
  } | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [canResend, setCanResend] = useState(false);
  // The submit button was disabled while the request ran, so focus would fall to the
  // page: it goes to the error instead, where a screen reader reads it.
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (fieldError?.field === "email") emailRef.current?.focus();
    else if (fieldError?.field === "password") passwordRef.current?.focus();
  }, [fieldError]);

  // Sign-up confirmation happens out of band (email link, possibly another
  // browser), so the login page's ?redirect= travels with it: GoTrue renders
  // emailRedirectTo as redirect_to in the confirmation link and /auth/confirm
  // lands there. Sign-in needs nothing: the page redirects on SIGNED_IN.
  const emailRedirectTo = () => `${window.location.origin}${redirectTo}`;

  const switchMode = (next: EmailPasswordMode) => {
    setMode(next);
    onModeChange?.(next);
    setError(null);
    setFieldError(null);
    setNotice(null);
    setDone(null);
    setCanResend(false);
    setPassword("");
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setFieldError(null);
    setNotice(null);
    setCanResend(false);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setFieldError({ field: "email", message: "Enter your email address" });
      return;
    }
    // A malformed address is reported before anything about the password.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setFieldError({
        field: "email",
        message: "Enter a full email address, like you@example.com",
      });
      return;
    }
    // GoTrue refuses these too (migration 00052), but its answer carries no
    // error code, so the form would only show the generic message.
    if (mode === "sign-up" && isCaptureDomainAddress(trimmedEmail, DEFAULT_EMAIL_DOMAIN)) {
      setFieldError({
        field: "email",
        message: `Addresses at ${DEFAULT_EMAIL_DOMAIN} can't be used for an account. Sign up with your own email address.`,
      });
      return;
    }
    if (mode !== "forgot" && password.length < PASSWORD_MIN_LENGTH) {
      setFieldError({
        field: "password",
        message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
      });
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

      // The site the reset was asked on: the link opens it there (/auth/confirm).
      const { error } = await supabase.auth.resetPasswordForEmail(trimmedEmail, {
        redirectTo: `${window.location.origin}/auth/reset-password`,
      });
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
        <div className="rounded-lg border border-border bg-background p-4 text-sm">{done}</div>
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
      {/* Sign-up needs no heading of its own: the page's says "Create your ... account". */}
      {mode === "forgot" ? <h2 className="text-base font-semibold">Reset your password</h2> : null}

      {notice ? (
        <div className="text-sm rounded-lg border border-border bg-background p-3" role="status">
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
          ref={emailRef}
          aria-invalid={fieldError?.field === "email" || undefined}
          aria-describedby={fieldError?.field === "email" ? "auth-email-error" : undefined}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
            if (fieldError?.field === "email") setFieldError(null);
          }}
          disabled={busy}
        />
        {fieldError?.field === "email" ? (
          <p id="auth-email-error" className="text-xs text-destructive-ink">
            {fieldError.message}
          </p>
        ) : null}
      </div>

      {mode !== "forgot" ? (
        // "Forgot password?" follows the input in the DOM, so Tab goes from the email to the
        // password; the grid still shows it on the label's row.
        <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-2">
          <Label htmlFor="auth-password" className="col-start-1 row-start-1">
            Password
          </Label>
          <Input
            className="col-span-2"
            id="auth-password"
            name="password"
            type="password"
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            required
            minLength={PASSWORD_MIN_LENGTH}
            ref={passwordRef}
            aria-invalid={fieldError?.field === "password" || undefined}
            aria-describedby={
              [
                fieldError?.field === "password" ? "auth-password-error" : null,
                mode === "sign-up" && fieldError?.field !== "password"
                  ? "auth-password-hint"
                  : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
              if (fieldError?.field === "password") setFieldError(null);
            }}
            disabled={busy}
          />
          {mode === "sign-in" ? (
            <button
              type="button"
              onClick={() => switchMode("forgot")}
              className="col-start-2 row-start-1 justify-self-end py-1.5 -my-1.5 text-xs underline text-muted-foreground hover:text-foreground"
            >
              Forgot password?
            </button>
          ) : null}
          {fieldError?.field === "password" ? (
            <p id="auth-password-error" className="col-span-2 text-xs text-destructive-ink">
              {fieldError.message}
            </p>
          ) : null}
          {mode === "sign-up" && fieldError?.field !== "password" ? (
            <p id="auth-password-hint" className="col-span-2 text-xs text-muted-foreground">
              At least {PASSWORD_MIN_LENGTH} characters.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Under the fields, next to what it is about, and gone once either changes. */}
      {error ? (
        <div
          ref={alertRef}
          tabIndex={-1}
          className="text-sm text-destructive-ink bg-destructive/10 border border-destructive/40 rounded-md p-3"
          role="alert"
        >
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
