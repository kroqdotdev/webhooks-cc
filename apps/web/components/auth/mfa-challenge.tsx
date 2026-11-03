"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { createClient } from "@/lib/supabase/client";

/**
 * Whether the signed-in session still owes its second factor: the account
 * has an authenticator app and this session signed in without its code.
 * Null while it is being worked out (from the session itself, no request).
 */
export function useNeedsSecondFactor(sessionKey: string | null): boolean | null {
  // Keyed by the session, so a new session reads as unknown until checked.
  const [state, setState] = useState<{ key: string; needs: boolean } | null>(null);
  useEffect(() => {
    if (!sessionKey) return;
    let cancelled = false;
    void createClient()
      .auth.mfa.getAuthenticatorAssuranceLevel()
      .then(({ data }) => {
        if (!cancelled) {
          setState({
            key: sessionKey,
            needs: data?.nextLevel === "aal2" && data.currentLevel !== "aal2",
          });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ key: sessionKey, needs: false });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);
  if (!sessionKey) return false;
  return state?.key === sessionKey ? state.needs : null;
}

/** Asks for the authenticator app's code after a password or link sign-in. */
export function MfaChallenge({ onVerified }: { onVerified: () => void }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const digits = code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(digits)) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setChecking(true);
    try {
      const supabase = createClient();
      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError) throw listError;
      const factor = factors.totp.find((entry) => entry.status === "verified");
      if (!factor) {
        onVerified();
        return;
      }
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: factor.id,
        code: digits,
      });
      if (verifyError) {
        setError("That code did not work. Codes change every 30 seconds; try the current one.");
        setCode("");
        return;
      }
      onVerified();
    } catch {
      setError("The code could not be checked. Try again.");
    } finally {
      setChecking(false);
    }
  };

  const signOut = async () => {
    await createClient().auth.signOut();
    router.push("/login");
  };

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <form onSubmit={verify} className="ui-card ui-card-static w-full max-w-sm space-y-4">
        <ShieldCheck className="h-6 w-6 text-primary" aria-hidden="true" />
        <div className="space-y-1">
          <h1 className="text-xl font-bold clean:font-semibold">Two-factor sign-in</h1>
          <p className="text-sm text-muted-foreground">
            Enter the 6-digit code from your authenticator app to finish signing in.
          </p>
        </div>
        <label htmlFor="mfa-code" className="sr-only">
          Code
        </label>
        <Input
          ref={inputRef}
          id="mfa-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          className="text-center font-mono text-lg tracking-[0.3em]"
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={checking}>
          {checking ? "Checking..." : "Verify"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Lost your authenticator?{" "}
          <a href="mailto:support@webhooks.cc" className="underline underline-offset-2">
            Email support
          </a>{" "}
          from the account&rsquo;s address, or{" "}
          <button
            type="button"
            onClick={() => void signOut()}
            className="underline underline-offset-2"
          >
            sign out
          </button>
          .
        </p>
      </form>
    </div>
  );
}

/**
 * For pages that sign in on their own rather than through RequireAuth (OAuth
 * consent, agent claims, CLI verification): asks for the authenticator code
 * before the page talks to the API, which refuses a session without it.
 */
export function MfaGate({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const needs = useNeedsSecondFactor(session?.access_token ?? null);
  const [verified, setVerified] = useState(false);
  if (session && needs === null) return null;
  if (needs && !verified) return <MfaChallenge onVerified={() => setVerified(true)} />;
  return <>{children}</>;
}
