"use client";

import { useCallback, useEffect, useState } from "react";
import { InlineMessage, Panel } from "@/components/settings/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";

interface Factor {
  id: string;
  status: string;
  friendly_name?: string;
  created_at: string;
}

interface Enrollment {
  factorId: string;
  qr: string;
  secret: string;
}

/**
 * Two-factor sign-in with an authenticator app (GoTrue TOTP). Turning it on
 * makes every new sign-in ask for a code, and the API refuses a session that
 * skipped it. Staff need it for operations.
 */
export function TwoFactor() {
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: listError } = await createClient().auth.mfa.listFactors();
    if (listError) {
      setError("Two-factor settings could not be loaded.");
      return;
    }
    setFactors(data.all as Factor[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const verified = (factors ?? []).find((factor) => factor.status === "verified");

  const start = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const supabase = createClient();
      // A setup that was never finished blocks a new one.
      for (const factor of factors ?? []) {
        if (factor.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: factor.id });
      }
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}`,
      });
      if (enrollError || !data) throw enrollError ?? new Error();
      setEnrollment({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    } catch {
      setError("Two-factor sign-in could not be started. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!enrollment) return;
    const digits = code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(digits)) {
      setError("Enter the 6-digit code your app shows.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: verifyError } = await createClient().auth.mfa.challengeAndVerify({
      factorId: enrollment.factorId,
      code: digits,
    });
    setBusy(false);
    if (verifyError) {
      setError("That code did not work. Check the time on your phone and try the current code.");
      return;
    }
    setEnrollment(null);
    setCode("");
    setMessage("Two-factor sign-in is on. Every new sign-in asks for a code from your app.");
    await load();
  };

  const turnOff = async () => {
    if (!verified) return;
    setBusy(true);
    setError(null);
    const { error: unenrollError } = await createClient().auth.mfa.unenroll({
      factorId: verified.id,
    });
    setBusy(false);
    if (unenrollError) {
      setError("Two-factor sign-in could not be turned off. Sign in again and retry.");
      return;
    }
    setMessage("Two-factor sign-in is off.");
    await load();
  };

  return (
    <Panel
      id="two-factor"
      title="Two-factor sign-in"
      description="Ask for a code from an authenticator app (1Password, Google Authenticator, Authy and the like) whenever you sign in."
    >
      {factors === null ? (
        error ? (
          <InlineMessage tone="error">{error}</InlineMessage>
        ) : (
          <div role="status" aria-label="Loading" className="space-y-2">
            <Skeleton className="h-4 w-1/2 rounded-md" />
          </div>
        )
      ) : enrollment ? (
        <form onSubmit={confirm} className="space-y-4">
          <p className="text-sm">
            Scan this code with your authenticator app, then enter the 6-digit code it shows.
          </p>
          <div className="flex flex-wrap items-start gap-5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={enrollment.qr}
              alt="QR code for your authenticator app"
              className="h-40 w-40 rounded-md border border-line bg-white p-2"
            />
            <div className="min-w-0 space-y-1 text-sm">
              <p className="text-muted-foreground">Cannot scan? Enter this key instead:</p>
              <code className="ui-code block break-all rounded-md px-2 py-1 font-mono text-xs">
                {enrollment.secret}
              </code>
            </div>
          </div>
          <div className="flex max-w-xs gap-2">
            <label htmlFor="totp-code" className="sr-only">
              Code
            </label>
            <Input
              id="totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className="font-mono tracking-widest"
            />
            <Button type="submit" disabled={busy}>
              Turn on
            </Button>
          </div>
          {error && <InlineMessage tone="error">{error}</InlineMessage>}
          <Button type="button" variant="ghost" size="sm" onClick={() => setEnrollment(null)}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            {verified
              ? "On. Every new sign-in asks for a code from your authenticator app."
              : "Off. Signing in needs only your password, email link or GitHub or Google account."}
          </p>
          {message && <InlineMessage tone="success">{message}</InlineMessage>}
          {error && <InlineMessage tone="error">{error}</InlineMessage>}
          {verified ? (
            <Button variant="outline" disabled={busy} onClick={() => void turnOff()}>
              Turn off two-factor sign-in
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void start()}>
              Set up two-factor sign-in
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}
