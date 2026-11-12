"use client";

import { useCallback, useEffect, useState } from "react";
import { InlineMessage, Panel } from "@/components/settings/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { apiFetch } from "@/lib/support/client";
import { copyToClipboard } from "@/lib/clipboard";
import { CodeBox } from "@/components/ui/code";

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
  const [codes, setCodes] = useState<string[] | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [stepUpCode, setStepUpCode] = useState("");
  const { session } = useAuth();
  const token = session?.access_token ?? null;

  const load = useCallback(async () => {
    const { data, error: listError } = await createClient().auth.mfa.listFactors();
    if (listError) {
      setError("Two-factor settings could not be loaded.");
      return;
    }
    setFactors(data.all as Factor[]);
  }, []);

  const loadRemaining = useCallback(async () => {
    if (!token) return;
    try {
      const data = await apiFetch<{ remaining: number }>(token, "/api/account/mfa/recovery-codes");
      setRemaining(data.remaining);
    } catch {
      setRemaining(null);
    }
  }, [token]);

  const makeCodes = async (accessToken: string | null) => {
    try {
      const data = await apiFetch<{ codes: string[] }>(
        accessToken,
        "/api/account/mfa/recovery-codes",
        {
          method: "POST",
        }
      );
      setCodes(data.codes);
      setRemaining(data.codes.length);
    } catch (codesError) {
      setError(
        codesError instanceof Error ? codesError.message : "Recovery codes could not be made."
      );
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const verified = (factors ?? []).find((factor) => factor.status === "verified");

  useEffect(() => {
    if (verified) void loadRemaining();
  }, [verified, loadRemaining]);

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
    // The session just moved to aal2; the codes need that session's token.
    const { data: fresh } = await createClient().auth.getSession();
    await makeCodes(fresh.session?.access_token ?? token);
  };

  const turnOff = async () => {
    if (!verified) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    // GoTrue lets only a session that passed the code remove a factor. A
    // session carried over from the other site (migration 00088) has not
    // in GoTrue's eyes, so it asks for the code once here first.
    const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (level?.currentLevel !== "aal2") {
      const digits = stepUpCode.replace(/\s+/g, "");
      if (!/^\d{6}$/.test(digits)) {
        setBusy(false);
        setStepUp(true);
        if (stepUp) setError("Enter the 6-digit code from your authenticator app.");
        return;
      }
      const { error: stepError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: verified.id,
        code: digits,
      });
      if (stepError) {
        setBusy(false);
        setError("That code did not work. Try the current one.");
        return;
      }
      setStepUp(false);
      setStepUpCode("");
    }
    const { error: unenrollError } = await supabase.auth.mfa.unenroll({
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
              className="h-40 w-40 rounded-md border bg-white p-2"
            />
            <div className="min-w-0 space-y-1 text-sm">
              <p className="text-muted-foreground">Cannot scan? Enter this key instead:</p>
              <CodeBox
                className="block break-all rounded-md px-2 py-1 font-mono text-xs"
                render={<code />}
              >
                {enrollment.secret}
              </CodeBox>
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
      ) : codes ? (
        <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            {verified
              ? "On. Every new sign-in asks for a code from your authenticator app."
              : "Off. Signing in needs only your password, email link or GitHub or Google account."}
          </p>
          {message && <InlineMessage tone="success">{message}</InlineMessage>}
          {error && <InlineMessage tone="error">{error}</InlineMessage>}
          {verified && (
            <p className="text-sm text-muted-foreground">
              {remaining === null
                ? "Recovery codes let you sign in if you lose your authenticator."
                : remaining === 0
                  ? "You have no recovery codes left. Make new ones so you can still sign in if you lose your authenticator."
                  : `${remaining} recovery code${remaining === 1 ? "" : "s"} left. Each signs you in once if you lose your authenticator.`}
            </p>
          )}
          {verified ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (
                    remaining === 0 ||
                    window.confirm("Make new recovery codes? The codes you have now stop working.")
                  ) {
                    void makeCodes(token);
                  }
                }}
              >
                Make new recovery codes
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void turnOff()}>
                Turn off two-factor sign-in
              </Button>
            </div>
          ) : null}
          {verified && stepUp ? (
            <div className="flex max-w-sm flex-wrap items-center gap-2">
              <label htmlFor="step-up-code" className="w-full text-sm text-muted-foreground">
                Enter the code from your authenticator app to turn it off.
              </label>
              <Input
                id="step-up-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                value={stepUpCode}
                onChange={(event) => setStepUpCode(event.target.value)}
                className="w-32 font-mono tracking-widest"
              />
              <Button variant="outline" disabled={busy} onClick={() => void turnOff()}>
                Confirm
              </Button>
            </div>
          ) : null}
          {verified ? null : (
            <Button disabled={busy} onClick={() => void start()}>
              Set up two-factor sign-in
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}

/** The codes, once: copy, download, and a confirmation that they are kept. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `webhooks.cc recovery codes\nEach code signs you in once, without your authenticator.\n\n${codes.join("\n")}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "webhooks-cc-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">Save your recovery codes</p>
        <p className="text-sm text-muted-foreground">
          If you lose your authenticator, each code signs you in once and turns two-factor sign-in
          off so you can set it up again. Keep them somewhere safe, like a password manager. They
          are shown only now.
        </p>
      </div>
      <ol className="ph-no-capture grid max-w-sm grid-cols-2 gap-x-6 gap-y-1 rounded-md border p-4 font-mono text-sm tabular-nums">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={async () => {
            if (await copyToClipboard(codes.join("\n"))) {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }
          }}
        >
          {copied ? "Copied" : "Copy codes"}
        </Button>
        <Button variant="outline" onClick={download}>
          Download
        </Button>
        <Button onClick={onDone}>I saved them</Button>
      </div>
    </div>
  );
}
